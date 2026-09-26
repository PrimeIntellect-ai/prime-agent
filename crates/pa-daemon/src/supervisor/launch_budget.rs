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
/// Pause between probe attempts (TS backoff min = max on Unix).
#[cfg(unix)]
pub(super) const WORKER_CONNECT_BACKOFF_MS: u64 = 25;
#[cfg(not(unix))]
pub(super) const WORKER_CONNECT_BACKOFF_MS: u64 = 2_000;
