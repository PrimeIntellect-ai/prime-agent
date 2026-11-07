//! The reconnect machinery: the update-restart resume window, the unexpected-loss hiccup loop, and
//! the announced shutdown's bounded recovery.

use super::{mpsc, DaemonClient, DaemonClientEvent, Duration, RecoveryKind};

/// The in-flight reconnect attempt's connect leg: a spawned task's bounded
/// `DaemonClient::connect_with_retry` result (fresh client plus its event receiver).
pub(super) type ReconnectConnect = tokio::sync::oneshot::Receiver<
    anyhow::Result<(DaemonClient, mpsc::UnboundedReceiver<DaemonClientEvent>)>,
>;

/// Spec §10.2: the client reconnect window after an update restart (10 minutes).
const RECONNECT_WINDOW: Duration = Duration::from_mins(10);

/// The reconnect backoff cap.
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(10);

/// TS #2458 `DAEMON_RECONNECT_TIMEOUT_MS`: the announced non-update closing's recovery
/// window — an explicit stop stays stopped, so the pane waits bounded instead of retrying
/// through the §10.2 resume window.
pub(super) const DAEMON_SHUTDOWN_RECONNECT_WINDOW: Duration = Duration::from_secs(60);

/// TS #2458 `SHUTDOWN_RECONNECT_RETRY_MS`: the shutdown recovery's poll
/// cadence (fixed, unlike the doubling hiccup backoff).
pub(super) const SHUTDOWN_RECONNECT_RETRY: Duration = Duration::from_millis(100);

/// TS `DAEMON_RECONNECT_TIMEOUT_MS`: the bounded session-plane reconnect
/// window after the direct worker link dies.
const SESSION_RECONNECT_WINDOW: Duration = Duration::from_mins(1);
/// TS reconnect backoff cap (`min(2000, 100 * 2 ** min(attempt, 5))`).
const SESSION_RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(2);
/// One re-attach attempt's budget: the attach carries its own request timeouts; this bounds a
/// wedged attempt so the loop reschedules instead of blocking the UI.
pub(super) const SESSION_RECONNECT_ATTEMPT_TIMEOUT_S: u64 = 10;

/// The interactive loop's session re-attach driver (TS `DaemonAgentConnection.reconnect`): the
/// worker process behind the direct link died, so the attach retries through the supervisor — which
/// respawns the worker and hands out a fresh peer ticket — with the TS backoff inside the TS
/// window.
pub(super) struct SessionReconnect {
    pub(super) active_session_id: String,
    pub(super) deadline: tokio::time::Instant,
    pub(super) next_attempt: tokio::time::Instant,
    delay: Duration,
    pub(super) last_error: String,
}

impl SessionReconnect {
    pub(super) fn start(active_session_id: &str) -> Self {
        SessionReconnect {
            active_session_id: active_session_id.to_string(),
            deadline: tokio::time::Instant::now() + SESSION_RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now(),
            delay: Duration::from_millis(100),
            last_error: String::new(),
        }
    }

    /// The next attempt with doubling backoff (capped).
    pub(super) fn next_attempt(mut self) -> Self {
        self.delay = (self.delay * 2).min(SESSION_RECONNECT_BACKOFF_MAX);
        self.next_attempt = tokio::time::Instant::now() + self.delay;
        self
    }
}

/// The interactive loop's full reconnect driver (spec §10.2): attempts with backoff inside the
/// window; the user can leave with Ctrl+C at any point. Three closings arm it — an update
/// restart's resume contract, an UNEXPECTED connection loss (a daemon hiccup at load, 2026-09-24:
/// the one-shot path exited the operator's TUI with "the daemon connection closed"), and an
/// ANNOUNCED non-update closing (TS #2458: the operator's own shutdown used to kill every
/// attached window) — the pane keeps its transcript and retries instead of dying.
pub(crate) struct ReconnectLoop {
    pub(super) deadline: tokio::time::Instant,
    pub(super) next_attempt: tokio::time::Instant,
    pub(super) delay: Duration,
    /// The closing that armed this driver: the reattach banner and the expiry row follow it.
    pub(super) kind: RecoveryKind,
}

impl ReconnectLoop {
    /// Spec §10.2: the update restart's resume window.
    pub(super) fn start_update() -> Self {
        let delay = Duration::from_secs(1);
        ReconnectLoop {
            deadline: tokio::time::Instant::now() + RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now() + delay,
            delay,
            kind: RecoveryKind::Update,
        }
    }

    /// The unexpected-loss variant: same window, same backoff, its own expiry row.
    pub(super) fn start_lost() -> Self {
        let delay = Duration::from_secs(1);
        ReconnectLoop {
            deadline: tokio::time::Instant::now() + RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now() + delay,
            delay,
            kind: RecoveryKind::Lost,
        }
    }

    /// TS #2458 `reconnectAfterShutdown`: the announced non-update closing. The window is the TS
    /// reconnect timeout (not the §10.2 resume window — an explicit stop stays stopped), the
    /// cadence is the TS fixed poll, and the expiry is the saved-transcript close.
    pub(super) fn start_shutdown() -> Self {
        ReconnectLoop {
            deadline: tokio::time::Instant::now() + DAEMON_SHUTDOWN_RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now() + SHUTDOWN_RECONNECT_RETRY,
            delay: SHUTDOWN_RECONNECT_RETRY,
            kind: RecoveryKind::Shutdown,
        }
    }

    /// The next attempt: doubling backoff (capped) for the resume and
    /// hiccup windows; the shutdown recovery keeps the TS fixed poll.
    pub(super) fn next_attempt(mut self) -> Self {
        if !matches!(self.kind, RecoveryKind::Shutdown) {
            self.delay = (self.delay * 2).min(RECONNECT_BACKOFF_MAX);
        }
        self.next_attempt = tokio::time::Instant::now() + self.delay;
        self
    }
}

/// The daemon connection's recovery state. [`Connection::on`] is its only writer: the client-event
/// fold and the run loop's select arms feed it events, and the arms only perform the IO it asks for.
pub(crate) enum Connection {
    Connected,
    /// The full reconnect driver owns the run (an update restart, a lost connection, or an
    /// announced shutdown).
    Recovering(ReconnectLoop),
}

/// One input to [`Connection::on`].
pub(crate) enum ConnectionEvent {
    /// A `daemon_closing` update frame (§10.2).
    UpdateNotice { est_seconds: u64 },
    /// A `daemon_closing` frame announcing the daemon's own shutdown (TS #2458).
    ShutdownNotice,
    /// The connection closed without a notice: a daemon hiccup.
    ConnectionLost,
    /// The reconnect driver's next attempt is due.
    Tick,
    /// The in-flight connect attempt returned.
    AttemptLanded,
    /// The connect attempt failed: back off and retry.
    ConnectFailed,
    /// The reattach outlived its budget (a slow restore): retry (§10.4 — never fatal).
    RestoreRetry,
    /// The reattach failed.
    ReattachFailed(String),
    /// The reattach landed on the fresh connection.
    Reattached,
}

/// What the run loop shows or does after one [`Connection::on`] step.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConnectionEffect {
    None,
    Note(String),
    Warning(String),
    /// Spawn one connect attempt: `retry` picks the retrying connect, the announced shutdown's poll
    /// makes one bounded connect per attempt.
    Connect {
        retry: bool,
    },
    /// The run ends with this note and exit reason.
    Exit {
        note: String,
        reason: &'static str,
    },
}

const LOST_NOTE: &str = "the daemon connection closed — reconnecting…";

impl Connection {
    /// Apply one event and return what the caller shows or does next.
    pub(crate) fn on(&mut self, event: ConnectionEvent) -> ConnectionEffect {
        use ConnectionEvent as Event;
        let now = tokio::time::Instant::now();
        match (event, &mut *self) {
            // An update closing outranks a shutdown or hiccup recovery in flight (TS #2458): the
            // §10.2 resume contract replaces it.
            (Event::UpdateNotice { est_seconds }, _) => {
                *self = Connection::Recovering(ReconnectLoop::start_update());
                ConnectionEffect::Note(format!(
                    "the daemon is restarting for an update (about {}s) — reconnecting…",
                    est_seconds.max(1)
                ))
            }
            // TS #2458 `reconnectAfterShutdown`: the announced closing keeps the pane mounted and
            // waits bounded (the recovery never relaunches the daemon — an explicit stop stays
            // stopped).
            (Event::ShutdownNotice, state) if !matches!(state, Connection::Recovering(_)) => {
                *self = Connection::Recovering(ReconnectLoop::start_shutdown());
                ConnectionEffect::Warning(
                    "the Prime Agent daemon shut down; waiting for it to come back…".to_string(),
                )
            }
            // An unexpected loss is a daemon hiccup, not a session end: the pane keeps its
            // transcript and retries; the window expires into the exit note.
            (Event::ConnectionLost, state) if !matches!(state, Connection::Recovering(_)) => {
                *self = Connection::Recovering(ReconnectLoop::start_lost());
                ConnectionEffect::Warning(LOST_NOTE.to_string())
            }
            (Event::Tick | Event::AttemptLanded, Connection::Recovering(driver))
                if now > driver.deadline =>
            {
                let effect = expiry(driver.kind);
                *self = Connection::Connected;
                effect
            }
            (Event::Tick, Connection::Recovering(driver)) => ConnectionEffect::Connect {
                retry: !matches!(driver.kind, RecoveryKind::Shutdown),
            },
            (Event::ConnectFailed, Connection::Recovering(_)) => {
                self.back_off();
                ConnectionEffect::None
            }
            (Event::RestoreRetry, Connection::Recovering(_)) => {
                self.back_off();
                ConnectionEffect::Note("the daemon is still restoring — retrying…".to_string())
            }
            // An update's reattach failure detaches the window; a lost or shutdown recovery keeps
            // retrying through its window (the worker may still be respawning).
            (Event::ReattachFailed(error), Connection::Recovering(driver)) => match driver.kind {
                RecoveryKind::Update => ConnectionEffect::Exit {
                    note: format!(
                        "reattach after the update failed: {error} — run `prime-agent attach` to resume"
                    ),
                    reason: "update_reattach_failed",
                },
                RecoveryKind::Lost | RecoveryKind::Shutdown => {
                    self.back_off();
                    ConnectionEffect::Warning(format!("reattach failed: {error} — retrying…"))
                }
            },
            (Event::Reattached, _) => {
                *self = Connection::Connected;
                ConnectionEffect::None
            }
            _ => ConnectionEffect::None,
        }
    }

    fn back_off(&mut self) {
        if let Connection::Recovering(driver) = std::mem::replace(self, Connection::Connected) {
            *self = Connection::Recovering(driver.next_attempt());
        }
    }
}

/// The recovery window expired without a reattach: the kind-specific exit row.
fn expiry(kind: RecoveryKind) -> ConnectionEffect {
    let (note, reason) = match kind {
        // The saved-transcript close (the session file survives on disk).
        RecoveryKind::Shutdown => (
            "The Prime Agent daemon shut down while this window was attached. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
            "daemon_closed",
        ),
        RecoveryKind::Lost => (
            "could not reconnect to the daemon within 10 minutes — run `prime-agent attach` to resume.",
            "daemon_reconnect_failed",
        ),
        RecoveryKind::Update => (
            "could not reconnect to the daemon within 10 minutes — the update finished but this window is detached. Run `prime-agent attach` to resume.",
            "update_reconnect_failed",
        ),
    };
    ConnectionEffect::Exit {
        note: note.to_string(),
        reason,
    }
}
