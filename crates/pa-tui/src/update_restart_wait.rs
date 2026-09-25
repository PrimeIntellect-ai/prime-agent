//! The bounded open wait through a daemon update restart (TS #2391
//! `waitThroughDaemonUpdateRestart`): an agents-view open that arrives
//! while the daemon prepares an update restart — or while the restart
//! itself takes the socket down — waits and retries against the successor
//! instead of failing the open.
//!
//! The first `Daemon is preparing an update restart` rejection arms the
//! wait (500ms retry cadence, 240s budget — the same budget attached
//! sessions get to reconnect after an update). Once armed, only
//! restart-transient failures stay inside the loop: they are all part of
//! the same normal update restart. A non-update error before any
//! update-restart signal propagates unchanged, and a permanent failure
//! after arming surfaces unmasked instead of hiding behind the wait.

use std::future::Future;

use anyhow::{anyhow, Result};

use crate::daemon_client::{is_update_restarting_rejection, RequestRejected};

/// TS `DAEMON_UPDATE_RESTART_OPEN_WAIT_MS`: mirrors the update
/// coordinator's worst case (100s prepare + supervisor stop + 60s
/// successor startup + session restore), the same budget attached
/// sessions get to reconnect after an update.
pub(crate) const DAEMON_UPDATE_RESTART_OPEN_WAIT_MS: u64 = 240_000;

/// TS `DAEMON_UPDATE_RESTART_OPEN_RETRY_MS`: the wait's retry cadence.
pub(crate) const DAEMON_UPDATE_RESTART_OPEN_RETRY_MS: u64 = 500;

/// The notice a waited-through open surfaces (TS `updateRestartWaitNotice`):
/// the session startup warning row and the agents-view status line.
pub(crate) const DAEMON_UPDATE_RESTART_WAIT_NOTICE: &str =
    "Waited for the Prime Agent daemon update restart to finish before opening this agent";

/// True when an open failure is part of the normal update-restart window
/// rather than a permanent failure (TS `isDaemonUpdateRestartTransientError`):
/// the preparing-restart rejection itself, transport failures while the
/// daemon exits and its successor boots (connect/handshake/response
/// timeouts, the closed-connection failure), and session-not-restored-yet
/// misses ("Unknown active session" rejections, a recovering session).
/// Permanent create and attach failures (e.g. a lease-holder refusal)
/// stay false, so the open fails immediately instead of hiding behind the
/// bounded update wait.
pub(crate) fn is_update_restart_transient_error(error: &anyhow::Error) -> bool {
    if is_update_restarting_rejection(error) {
        return true;
    }
    error.chain().any(|cause| {
        if let Some(rejected) = cause.downcast_ref::<RequestRejected>() {
            // The restart restores sessions from the prepared roster: a
            // session the successor has not restored yet answers with the
            // unknown-session refusal, and one still hydrating with the
            // recovering rejection — both are the same wait.
            if rejected.message.starts_with("Unknown active session: ") {
                return true;
            }
            if matches!(
                &rejected.error_info,
                Some(pa_types::daemon::DaemonErrorInfo::SessionRecovering { .. })
            ) {
                return true;
            }
        }
        // Transport failures while the daemon exits for the restart and
        // while its successor boots: the socket closes under the request,
        // the connect is refused until the successor listens, and the
        // connect/handshake/response requests time out in between.
        let text = cause.to_string();
        text.starts_with("Connection to the Prime Agent daemon closed")
            || text.starts_with("Failed to connect to the Prime Agent daemon")
            || is_daemon_transport_timeout(&text)
    })
}

/// The TS timeout shapes: `Timed out after <n>ms connecting to the Prime
/// Agent daemon`, `... waiting for the Prime Agent daemon handshake`, and
/// `... waiting for the Prime Agent daemon response` (TS matches
/// `response to`; the client's own rendered form is the same prefix).
fn is_daemon_transport_timeout(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("Timed out after ") else {
        return false;
    };
    let Some((digits, tail)) = rest.split_once("ms ") else {
        return false;
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    tail.starts_with("connecting to the Prime Agent daemon")
        || tail.starts_with("waiting for the Prime Agent daemon handshake")
        || tail.starts_with("waiting for the Prime Agent daemon response")
}

/// TS `daemonUpdateRestartDeadlineError`: the bounded wait's failure —
/// actionable, and carrying the last error for diagnosis.
fn update_restart_deadline_error(
    wait_ms: u64,
    last_error: Option<&anyhow::Error>,
) -> anyhow::Error {
    let last = match last_error {
        Some(error) => format!("{error:#}"),
        None => "none yet".to_string(),
    };
    anyhow!(
        "The Prime Agent daemon did not finish its update restart within {} seconds. Try opening this agent again once the update finishes. Last error: {}",
        wait_ms / 1000,
        last
    )
}

/// Run an open attempt, retrying while the daemon is in the update-restart
/// transient state instead of failing the open (TS
/// `waitThroughDaemonUpdateRestart`). The first preparing-restart rejection
/// arms the wait; once armed, only restart-transient failures stay inside
/// the same bounded loop, while permanent failures propagate immediately
/// instead of hiding behind the wait. A non-update error before any
/// update-restart signal propagates unchanged. The wait budget bounds the
/// whole wait: each attempt is raced against the remaining budget, so an
/// in-flight attempt (a create with its own request timeout) cannot hold
/// the open past the deadline — the losing attempt is dropped (its
/// connection dies with it, the same disposal TS hands the late result).
/// On success the outcome reports whether the wait armed, so the caller
/// surfaces the wait notice only when it actually waited.
pub(crate) async fn wait_through_update_restart<F, Fut, T>(
    enabled: bool,
    wait_ms: u64,
    retry_ms: u64,
    mut attempt: F,
) -> Result<(T, bool)>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    if !enabled {
        return Ok((attempt().await?, false));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms.max(1));
    let retry = std::time::Duration::from_millis(retry_ms.max(1));
    let mut armed = false;
    let mut last_error: Option<anyhow::Error> = None;
    loop {
        // TS races every attempt against the remaining budget so the bound
        // holds even over an in-flight create.
        let attempt = attempt();
        let result = tokio::select! {
            result = attempt => result,
            _ = tokio::time::sleep_until(deadline) => {
                return Err(update_restart_deadline_error(wait_ms, last_error.as_ref()));
            }
        };
        match result {
            Ok(opened) => return Ok((opened, armed)),
            Err(error) => {
                if !armed {
                    if !is_update_restarting_rejection(&error) {
                        return Err(error);
                    }
                    armed = true;
                    log_update_restart_wait(&error);
                } else if !is_update_restart_transient_error(&error) {
                    return Err(error);
                }
                let now = tokio::time::Instant::now();
                if now + retry > deadline {
                    return Err(update_restart_deadline_error(wait_ms, Some(&error)));
                }
                last_error = Some(error);
                tokio::time::sleep(retry).await;
            }
        }
    }
}

/// TS `logClientError` for the wait (agents-view open failures): the
/// record lands in `client-errors.log` — the TUI owns stdout/stderr, so a
/// rotating log file is the only safe sink.
fn log_update_restart_wait(error: &anyhow::Error) {
    use std::io::Write;
    let write = || -> std::io::Result<()> {
        let Some(agent_dir) = pa_types::platform::agent_dir() else {
            return Ok(());
        };
        let dir = agent_dir.join("logs");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("client-errors.log");
        // TS `appendRotatingLog`: the oversize log rolls to `.old`, then
        // the line appends; every failure stays silent (a broken log dir
        // must not break the open).
        const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
        if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(dir.join("client-errors.log.old"));
            let _ = std::fs::rename(&path, dir.join("client-errors.log.old"));
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)?;
        writeln!(
            file,
            "[{}] Waiting for daemon update restart to finish before opening: {error:#}",
            now_iso()
        )
    };
    let _ = write();
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` — the TS `new Date().toISOString()` shape
/// the client-errors log prefix carries (the same algorithm as
/// pa-daemon's util, which pa-tui cannot depend on).
fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let secs = (ms / 1000) as i64;
    let millis = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's civil-from-days (the days-from-civil algorithm in
/// reverse, the same one pa-tui's direct transport parses with).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejection(
        message: &str,
        error_info: Option<pa_types::daemon::DaemonErrorInfo>,
    ) -> anyhow::Error {
        anyhow::Error::new(RequestRejected {
            command: "create".to_string(),
            message: message.to_string(),
            error_info,
        })
    }

    fn preparing_rejection() -> anyhow::Error {
        rejection(
            "Daemon is preparing an update restart",
            Some(pa_types::daemon::DaemonErrorInfo::UpdateRestarting),
        )
    }

    /// TS `waitThroughDaemonUpdateRestart`: a non-update error before any
    /// update-restart signal propagates unchanged (exactly one attempt).
    #[tokio::test]
    async fn a_non_update_failure_before_any_signal_propagates() {
        let mut attempts = 0;
        let error = wait_through_update_restart(true, 5_000, 1, || {
            attempts += 1;
            std::future::ready(Err::<&'static str, anyhow::Error>(anyhow!("spawn EMFILE")))
        })
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "spawn EMFILE");
        assert_eq!(attempts, 1);
    }

    /// Post-arm transient shapes only (arming is pinned at the loop layer
    /// by the e2e): every restart-transient failure is retried and the
    /// outcome reports that it waited.
    #[tokio::test]
    async fn retries_every_restart_transient_failure_and_reports_the_wait() {
        let transient_failures: Vec<(&str, anyhow::Error)> = vec![
            (
                "the preparing rejection",
                preparing_rejection(),
            ),
            // Transport failures while the daemon exits and boots.
            (
                "connect refused",
                anyhow!("Failed to connect to the Prime Agent daemon. Socket: /s."),
            ),
            (
                "closed",
                anyhow!("Connection to the Prime Agent daemon closed. Socket: /s."),
            ),
            (
                "response timeout",
                anyhow!("Timed out after 30000ms waiting for the Prime Agent daemon response. Socket: /s."),
            ),
            (
                "connect timeout",
                anyhow!("Timed out after 5000ms connecting to the Prime Agent daemon. Socket: /s."),
            ),
            (
                "handshake timeout",
                anyhow!("Timed out after 5000ms waiting for the Prime Agent daemon handshake. Socket: /s."),
            ),
            // Session-not-restored-yet misses.
            (
                "unknown session",
                rejection("Unknown active session: update-restart-session", None),
            ),
            (
                "recovering session",
                rejection(
                    "Active session update-restart-session is recovering; retry shortly",
                    Some(pa_types::daemon::DaemonErrorInfo::SessionRecovering {
                        active_session_id: "update-restart-session".to_string(),
                    }),
                ),
            ),
        ];
        for (name, failure) in transient_failures {
            let mut attempts = 0;
            let mut failure = Some(failure);
            let outcome = wait_through_update_restart(true, 5_000, 1, || {
                attempts += 1;
                let next = match attempts {
                    1 => Err(preparing_rejection()),
                    2 => Err(failure.take().expect("the transient failure fires once")),
                    _ => Ok("opened"),
                };
                std::future::ready(next)
            })
            .await;
            assert_eq!(attempts, 3, "{name}: two failures then the open");
            let (opened, waited) = outcome.expect("the wait retries through the window");
            assert_eq!(opened, "opened");
            assert!(waited, "{name}: the wait reports itself");
        }
    }

    /// A permanent failure after arming surfaces unmasked (no retry
    /// through the window).
    #[tokio::test]
    async fn a_permanent_failure_after_arming_surfaces_unmasked() {
        let mut attempts = 0;
        let error = wait_through_update_restart(true, 5_000, 1, || {
            attempts += 1;
            let next = if attempts == 1 {
                preparing_rejection()
            } else {
                anyhow!("File not found: /tmp/scope.jsonl")
            };
            std::future::ready(Err::<&'static str, anyhow::Error>(next))
        })
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("File not found: /tmp/scope.jsonl"),
            "the permanent failure surfaces: {error}"
        );
        assert_eq!(attempts, 2, "no third attempt");
    }

    /// TS: the deadline races every attempt, so an in-flight attempt
    /// cannot hold the open past the budget.
    #[tokio::test]
    async fn the_deadline_fails_a_wait_past_its_budget() {
        let mut attempts = 0;
        let deadline_error = wait_through_update_restart(true, 60, 5, || {
            attempts += 1;
            let first_attempt = attempts == 1;
            async move {
                if first_attempt {
                    Err::<&'static str, anyhow::Error>(preparing_rejection())
                } else {
                    // An attempt that never settles (the in-flight create).
                    std::future::pending().await
                }
            }
        })
        .await
        .unwrap_err();
        assert!(
            deadline_error
                .to_string()
                .starts_with("The Prime Agent daemon did not finish its update restart within"),
            "the deadline error is actionable: {deadline_error}"
        );
        assert!(
            deadline_error.to_string().contains("Last error: "),
            "the deadline error carries the last error: {deadline_error}"
        );
        assert_eq!(attempts, 2);
    }

    /// A disabled route never waits: the single attempt runs straight
    /// through, so the CLI open keeps today's hard-failure behavior.
    #[tokio::test]
    async fn a_disabled_route_runs_one_attempt() {
        let mut attempts = 0;
        let error = wait_through_update_restart(true, 5_000, 1, || {
            attempts += 1;
            std::future::ready(Err::<&'static str, anyhow::Error>(preparing_rejection()))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(
            error.to_string(),
            "the daemon rejected the create request: Daemon is preparing an update restart"
        );
    }

    /// The transport-timeout shapes classify exactly (the TS prefix set).
    #[test]
    fn the_transport_timeout_shapes_classify_exactly() {
        for text in [
            "Timed out after 5000ms connecting to the Prime Agent daemon. Socket: /s.",
            "Timed out after 5000ms waiting for the Prime Agent daemon handshake. Socket: /s.",
            "Timed out after 30000ms waiting for the Prime Agent daemon response. Socket: /s.",
            "Timed out after 30000ms waiting for the Prime Agent daemon response to \"create\".",
        ] {
            assert!(is_daemon_transport_timeout(text), "{text}");
            assert!(
                is_update_restart_transient_error(&anyhow!("{text}")),
                "{text}"
            );
        }
        // A timeout that is not a daemon transport shape does not.
        assert!(!is_daemon_transport_timeout(
            "Timed out after 10ms waiting for the session response"
        ));
        assert!(!is_daemon_transport_timeout(
            "Timed out after ms connecting"
        ));
        assert!(!is_daemon_transport_timeout(
            "Timed out after 5x00ms connecting to the Prime Agent daemon"
        ));
    }

    /// The pinned TS constants: the wait budget mirrors the attached
    /// session reconnect budget, and the notice is the TS text verbatim.
    #[test]
    fn the_ts_constants_are_pinned() {
        assert_eq!(DAEMON_UPDATE_RESTART_OPEN_WAIT_MS, 240_000);
        assert_eq!(
            DAEMON_UPDATE_RESTART_WAIT_NOTICE,
            "Waited for the Prime Agent daemon update restart to finish before opening this agent"
        );
        assert_eq!(
            pa_types::daemon::UPDATE_RESTART_PREPARING_MESSAGE,
            "Daemon is preparing an update restart"
        );
    }

    /// The client-errors log prefix is the TS `toISOString()` shape.
    #[test]
    fn the_iso_prefix_shape_is_the_ts_toisostring() {
        let iso = now_iso();
        assert_eq!(iso.len(), 24);
        assert!(iso.ends_with('Z'));
        assert_eq!(iso.as_bytes()[4], b'-');
        assert_eq!(iso.as_bytes()[10], b'T');
        assert_eq!(iso.as_bytes()[19], b'.');
        // The civil-from-days conversion round-trips the epoch and a leap
        // year (the same algorithm the direct transport parses with).
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_673), (2026, 9, 24));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
