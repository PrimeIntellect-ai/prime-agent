//! The bounded open wait through a daemon update restart (TS #2391
//! `waitThroughDaemonUpdateRestart`):
//! an open that arrives while the daemon prepares a restart — or while the restart takes the
//! socket down — waits and retries against the successor instead of failing the open; only
//! restart-transient failures stay in the loop, and a permanent failure after arming unmasked.

use std::future::Future;

use anyhow::{anyhow, Result};

use crate::daemon_client::{is_update_restarting_rejection, RequestRejected};

/// The update coordinator's worst case, the same budget attached
/// sessions get to reconnect.
pub(crate) const DAEMON_UPDATE_RESTART_OPEN_WAIT_MS: u64 = 240_000;

pub(crate) const DAEMON_UPDATE_RESTART_OPEN_RETRY_MS: u64 = 500;

/// The notice a waited-through open surfaces (TS `updateRestartWaitNotice`).
pub(crate) const DAEMON_UPDATE_RESTART_WAIT_NOTICE: &str =
    "Waited for the Prime Agent daemon update restart to finish before opening this agent";

/// True when an open failure is part of the normal update-restart
/// window: the preparing-restart rejection, transport failures while
/// the daemon exits and boots, and session-not-restored-yet misses;
/// permanent failures stay false.
pub(crate) fn is_update_restart_transient_error(error: &anyhow::Error) -> bool {
    if is_update_restarting_rejection(error) {
        return true;
    }
    error.chain().any(|cause| {
        if let Some(rejected) = cause.downcast_ref::<RequestRejected>() {
            // A session the successor has not restored yet answers with
            // the unknown-session refusal; one still hydrating, with
            // the recovering rejection.
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
        let text = cause.to_string();
        text.starts_with("Connection to the Prime Agent daemon closed")
            || text.starts_with("the daemon connection closed")
            || text.starts_with("the daemon connection is closed")
            || text.starts_with("Failed to connect to the Prime Agent daemon")
            || is_daemon_transport_timeout(&text)
    })
}

/// True when the error is the open wait's deadline failure: the guidance
/// lands on the status line, never a process exit.
pub(crate) fn is_update_restart_deadline_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .starts_with("The Prime Agent daemon did not finish its update restart within")
    })
}

/// The TS timeout shapes: `Timed out after <n>ms connecting to ...`,
/// `... handshake`, and `... response`. Case-insensitive (hello/connect
/// capitalize `Timed`; the session's own requests do not).
fn is_daemon_transport_timeout(text: &str) -> bool {
    let lowered = text.to_lowercase();
    let Some(rest) = lowered.strip_prefix("timed out after ") else {
        return false;
    };
    let Some((digits, tail)) = rest.split_once("ms ") else {
        return false;
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    tail.starts_with("connecting to the prime agent daemon")
        || tail.starts_with("waiting for the prime agent daemon handshake")
        || tail.starts_with("waiting for the prime agent daemon response")
}

/// The bounded wait's failure, carrying the last error for diagnosis.
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

/// Run an open attempt, retrying while the daemon is in the
/// update-restart transient state. The first preparing-restart rejection
/// arms the wait; each attempt races the remaining budget, so an
/// in-flight attempt cannot hold the open past the deadline. The outcome
/// reports whether the wait armed.
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
        let attempt = attempt();
        let result = tokio::select! {
            result = attempt => result,
            () = tokio::time::sleep_until(deadline) => {
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

/// TS `logClientError` for the wait: the record lands in
/// `client-errors.log` — the TUI owns stdout/stderr, so a rotating
/// log file is the only safe sink.
fn log_update_restart_wait(error: &anyhow::Error) {
    use std::io::Write;
    // The synchronous filesystem write runs on a blocking thread,
    // fire-and-forget: a stalled agent-home filesystem must never block
    // the wait's retry loop (the select's deadline arm cannot fire
    // while blocked).
    let line = format!(
        "[{}] Waiting for daemon update restart to finish before opening: {error:#}",
        now_iso()
    );
    tokio::task::spawn_blocking(move || {
        let write = || -> std::io::Result<()> {
            // TS `appendRotatingLog`: the oversize log rolls to `.old`;
            // every failure stays silent (a broken log dir must not
            // break the open).
            const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
            let Some(agent_dir) = pa_types::platform::agent_dir() else {
                return Ok(());
            };
            let dir = agent_dir.join("logs");
            std::fs::create_dir_all(&dir)?;
            let path = dir.join("client-errors.log");
            if std::fs::metadata(&path).map_or(0, |meta| meta.len()) > MAX_LOG_BYTES {
                let _ = std::fs::remove_file(dir.join("client-errors.log.old"));
                let _ = std::fs::rename(&path, dir.join("client-errors.log.old"));
            }
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(&path)?;
            writeln!(file, "{line}")
        };
        let _ = write();
    });
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` — the TS `new Date().toISOString()` shape
/// (the same algorithm as pa-daemon's util, which pa-tui cannot
/// depend on).
fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64);
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

    #[tokio::test]
    async fn retries_every_restart_transient_failure_and_reports_the_wait() {
        let transient_failures: Vec<(&str, anyhow::Error)> = vec![
            (
                "the preparing rejection",
                preparing_rejection(),
            ),
            (
                "connect refused",
                anyhow!("Failed to connect to the Prime Agent daemon. Socket: /s."),
            ),
            (
                "closed",
                anyhow!("Connection to the Prime Agent daemon closed. Socket: /s."),
            ),
            (
                "pending-fail closed",
                anyhow!("the daemon connection closed"),
            ),
            (
                "pre-handshake closed",
                anyhow!("the daemon connection closed before the handshake"),
            ),
            (
                "dead writer",
                anyhow!("the daemon connection is closed"),
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

    #[tokio::test]
    async fn a_disabled_route_runs_one_attempt() {
        let mut attempts = 0;
        let error = wait_through_update_restart(false, 5_000, 1, || {
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

    #[test]
    fn the_transport_timeout_shapes_classify_exactly() {
        for text in [
            "Timed out after 5000ms connecting to the Prime Agent daemon. Socket: /s.",
            "Timed out after 5000ms waiting for the Prime Agent daemon handshake. Socket: /s.",
            "Timed out after 30000ms waiting for the Prime Agent daemon response. Socket: /s.",
            "Timed out after 30000ms waiting for the Prime Agent daemon response to \"create\".",
            "timed out after 30000ms waiting for the Prime Agent daemon response",
        ] {
            assert!(is_daemon_transport_timeout(text), "{text}");
            assert!(
                is_update_restart_transient_error(&anyhow!("{text}")),
                "{text}"
            );
        }
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

    #[test]
    fn the_deadline_error_classifies_for_the_handoff() {
        let deadline = update_restart_deadline_error(240_000, Some(&preparing_rejection()));
        assert!(is_update_restart_deadline_error(&deadline));
        assert!(
            deadline
                .to_string()
                .starts_with("The Prime Agent daemon did not finish its update restart within"),
            "{deadline}"
        );
        assert!(deadline.to_string().contains("Last error:"));
        assert!(!is_update_restart_deadline_error(&preparing_rejection()));
        assert!(!is_update_restart_deadline_error(&anyhow!(
            "the daemon rejected the create request: File not found: /tmp/scope.jsonl"
        )));
    }

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

    #[test]
    fn the_iso_prefix_shape_is_the_ts_toisostring() {
        let iso = now_iso();
        assert_eq!(iso.len(), 24);
        assert!(iso.ends_with('Z'));
        assert_eq!(iso.as_bytes()[4], b'-');
        assert_eq!(iso.as_bytes()[10], b'T');
        assert_eq!(iso.as_bytes()[19], b'.');
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_720), (2026, 9, 24));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
