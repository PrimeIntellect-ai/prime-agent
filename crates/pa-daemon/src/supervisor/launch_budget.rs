//! The worker launch budget: connect probes, the connect deadline,
//! the auth floor, and the env override.

/// Worker connect budget: socket probes, connect, and the auth handshake
/// all share this deadline from spawn time (TS `WORKER_CONNECT_TIMEOUT_MS`:
/// 30s on Unix, 90s on Windows). A worker that never comes up fails the
/// launch within this budget instead of hanging. The budget is
/// env-overridable (`WORKER_CONNECT_TIMEOUT_ENV`, ms) for environments
/// whose worker boots need more headroom (e.g. parallel e2e runs on
/// shared vCPUs); the default keeps the TS wire behavior.
#[cfg(unix)]
pub(super) const DEFAULT_WORKER_CONNECT_TIMEOUT_MS: u64 = 30_000;
#[cfg(not(unix))]
pub(super) const DEFAULT_WORKER_CONNECT_TIMEOUT_MS: u64 = 90_000;
/// The auth handshake's minimum budget. Probes, connect, and auth share the
/// connect deadline, but a probe phase that ate nearly all of it (a
/// slow-booting worker under load) must not leave the auth route with
/// crumbs: a worker that just proved life (the probe connected) gets at
/// least this long to answer the handshake, so the launch fails with the
/// connect-budget error only when the worker is genuinely wedged.
pub(super) const WORKER_AUTH_FLOOR_MS: u64 = 10_000;
/// Overrides [`DEFAULT_WORKER_CONNECT_TIMEOUT_MS`] when set to a positive
/// number of milliseconds (tests under parallel load use this seam).
pub(super) const WORKER_CONNECT_TIMEOUT_ENV: &str = "PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS";
/// One socket probe attempt (TS `WORKER_CONNECT_PROBE_MS`).
#[cfg(unix)]
pub(super) const WORKER_CONNECT_PROBE_MS: u64 = 500;
#[cfg(not(unix))]
pub(super) const WORKER_CONNECT_PROBE_MS: u64 = 2_000;
/// Pause between probe attempts. TS `WORKER_PROBE_BACKOFF_MIN_MS` (25ms)
/// doubles per retry up to `WORKER_PROBE_BACKOFF_MAX_MS` (win32 2s, unix
/// 25 - TS's min equals its max there, so the doubling is a flat grid).
/// This port keeps the unix pause flat at a tightened 5ms: a session
/// worker binds its socket ~1-3ms after the fork (measured cold-open
/// boot floor at 7064d039a, boot-floor lane record 20260926-194800), so
/// the 25ms grid quantized every spawn by 0-25ms (mean ~12.5ms) of pure
/// wait on the open path. Windows doubles exactly like TS (a flat 2s
/// first retry would sleep through the sub-second boots the doubling
/// exists to catch). Timing-only: the probe, the connect budget, the
/// auth floor, and the launch-failure error are unchanged.
#[cfg(unix)]
pub(super) const WORKER_CONNECT_BACKOFF_MS: u64 = 5;
/// TS `WORKER_PROBE_BACKOFF_MIN_MS`: the first retry pause.
#[cfg(not(unix))]
pub(super) const WORKER_PROBE_BACKOFF_MIN_MS: u64 = 25;
/// TS `WORKER_PROBE_BACKOFF_MAX_MS` (win32 arm:
/// `process.platform === "win32" ? 2_000 : 25`): the doubling cap.
#[cfg(not(unix))]
pub(super) const WORKER_PROBE_BACKOFF_MAX_MS: u64 = 2_000;

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// The TS win32 budgets (`daemon-supervisor.ts` :183-186): 90s
    /// connect, 2s probes, a 25ms first retry doubling to a 2s cap.
    /// The windows-latest job proves the values the TS product ships.
    #[test]
    fn windows_budgets_match_the_ts_values() {
        assert_eq!(DEFAULT_WORKER_CONNECT_TIMEOUT_MS, 90_000);
        assert_eq!(WORKER_CONNECT_PROBE_MS, 2_000);
        assert_eq!(WORKER_PROBE_BACKOFF_MIN_MS, 25);
        assert_eq!(WORKER_PROBE_BACKOFF_MAX_MS, 2_000);
    }
}
