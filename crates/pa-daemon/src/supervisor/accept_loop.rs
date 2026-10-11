//! The supervisor's client accept loop: transient accept errors warn and retry — an
//! exit would orphan every hosted session. The policy mirrors Codex's control-socket
//! acceptor. Deliberate divergences: recoverable streaks take the same backoff, and
//! retries are bounded by [`GIVE_UP_AFTER`] (a broken listener must release the bind).

use std::io::ErrorKind;
use std::time::Duration;

use pa_types::platform::transport::TransportListener;

use super::{anyhow, Arc, Ordering, Result, Supervisor};

/// The backoff before retrying a non-recoverable accept error (Codex
/// parity: the control-socket acceptor sleeps 1s between retries).
pub(super) const BACKOFF: Duration = Duration::from_secs(1);

/// Consecutive non-recoverable accept failures the loop survives before escalating the
/// error out of `run`: a deaf supervisor holding the bind singleton is worse than a
/// dead one. Any accepted connection resets the count.
pub(super) const GIVE_UP_AFTER: u32 = 60;

/// Consecutive recoverable accept errors after which the loop takes the same backoff,
/// so a stream of them cannot spin the loop hot or flood the log.
pub(super) const RECOVERABLE_STORM_AFTER: u32 = 8;

/// The 1s pause between retries, ended early by a shutdown wake: the loop may not
/// hold the daemon exit hostage to the full backoff.
async fn retry_backoff(supervisor: &Supervisor) {
    tokio::select! {
        () = tokio::time::sleep(BACKOFF) => {}
        () = supervisor.shutdown_notify.notified() => {}
    }
}

/// Serve clients until `begin_shutdown` completes its stop pass and sets the exit flag.
///
/// Owns the bound listener: every return path drops it, so the listener
/// is closed before the caller's exit cleanup runs (the TS graceful-
/// shutdown order - daemon-supervisor.ts:7436-7491 awaits the "daemon
/// server" close step, then runs the "daemon socket" cleanup step). A
/// live listener at the socket path after this returns can only be a
/// successor's, which is what makes the cleanup's liveness probe sound.
///
/// # Errors
///
/// Returns the transport's accept error once [`GIVE_UP_AFTER`] consecutive failures
/// exhaust the give-up budget; the caller exits, releasing the socket bind.
pub(super) async fn serve(
    supervisor: &Arc<Supervisor>,
    listener: Box<dyn TransportListener>,
) -> Result<()> {
    let mut consecutive_failures = 0u32;
    let mut recoverable_streak = 0u32;
    while !supervisor.accept_exit.load(Ordering::SeqCst) {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(accepted) => accepted,
                Err(error) => {
                    if supervisor.shutting_down.load(Ordering::SeqCst) {
                        continue;
                    }
                    if matches!(
                        error.kind(),
                        ErrorKind::ConnectionAborted
                            | ErrorKind::ConnectionReset
                            | ErrorKind::Interrupted
                    ) {
                        supervisor.log_line(&format!(
                            "supervisor accept error (recoverable), retrying: {error}"
                        ));
                        recoverable_streak += 1;
                        if recoverable_streak >= RECOVERABLE_STORM_AFTER {
                            retry_backoff(supervisor).await;
                            recoverable_streak = 0;
                        }
                        continue;
                    }
                    // The hard error's own backoff cools the storm
                    // streak too, like any other wait.
                    recoverable_streak = 0;
                    consecutive_failures += 1;
                    if consecutive_failures >= GIVE_UP_AFTER {
                        supervisor.log_line(&format!(
                            "supervisor accept failed {GIVE_UP_AFTER} times in a row, giving up: {error}"
                        ));
                        return Err(anyhow!("supervisor accept: {error}"));
                    }
                    supervisor.log_line(&format!(
                        "supervisor accept error {consecutive_failures}/{GIVE_UP_AFTER}, retrying: {error}"
                    ));
                    retry_backoff(supervisor).await;
                    continue;
                }
            },
            // begin_shutdown fired: loop back and fall out of the loop.
            () = supervisor.shutdown_notify.notified() => continue,
        };
        consecutive_failures = 0;
        recoverable_streak = 0;
        let supervisor = Arc::clone(supervisor);
        tokio::spawn(async move {
            if let Err(error) = supervisor
                .handle_client(stream, crate::supervisor::ClientTrust::Local)
                .await
            {
                eprintln!("pa-daemon client connection error: {error:#}");
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use pa_types::platform::transport::{
        AcceptFuture, AsyncReadHalf, AsyncWriteHalf, TransportStream,
    };
    use tempfile::TempDir;

    use crate::supervisor::{Supervisor, SupervisorOptions};

    use super::*;

    /// The scripted accept results, shared so the test can read what the
    /// loop consumed after the stand-in is moved into `serve` (the
    /// owned-listener shape the production loop takes now).
    type ScriptedResults = Arc<Mutex<VecDeque<io::Result<Box<dyn TransportStream>>>>>;

    /// A stand-in listener replaying a scripted accept sequence; when the script drains,
    /// it fires the shutdown wake and parks, so `serve` falls out like a real listener.
    struct ScriptedAccepts {
        results: ScriptedResults,
        supervisor: Arc<Supervisor>,
    }

    impl TransportListener for ScriptedAccepts {
        fn accept(&self) -> AcceptFuture<'_> {
            Box::pin(async move {
                // The guard must drop before the drained arm's await: the match scrutinee's
                // temporary lives for the whole match, and the parked arm would hold it
                // across the await.
                let next = self.results.lock().unwrap().pop_front();
                if let Some(result) = next {
                    result
                } else {
                    self.supervisor.accept_exit.store(true, Ordering::SeqCst);
                    self.supervisor.shutdown_notify.notify_one();
                    std::future::pending::<io::Result<Box<dyn TransportStream>>>().await
                }
            })
        }
    }

    fn accept_error(kind: io::ErrorKind, message: &str) -> io::Result<Box<dyn TransportStream>> {
        Err(io::Error::new(kind, message))
    }

    fn test_supervisor(dir: &TempDir) -> Arc<Supervisor> {
        Arc::new(
            Supervisor::new(SupervisorOptions {
                tcp_port: None,
                tcp_bind_host: None,
                remote_agent_mesh: None,
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .expect("supervisor"),
        )
    }

    /// One end of an in-memory duplex as the accepted stream (portable, so the tests run
    /// on Windows too); the dropped peer half reads EOF, like a vanished client.
    fn accepted_stream() -> Box<dyn TransportStream> {
        let (_, accepted) = tokio::io::duplex(4096);
        Box::new(DuplexTransport(Mutex::new(accepted)))
    }

    /// A duplex end as a [`TransportStream`]: a plain memory stream has no `into_split`, so
    /// the halves come from the shared-lock split (the `Mutex` carries `Sync`).
    struct DuplexTransport(Mutex<tokio::io::DuplexStream>);

    impl TransportStream for DuplexTransport {
        fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
            let stream = self.0.into_inner().expect("duplex lock");
            let (reader, writer) = tokio::io::split(stream);
            (Box::new(reader), Box::new(writer))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn recoverable_accept_errors_do_not_exit_the_loop() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(
                vec![
                    accept_error(ErrorKind::ConnectionAborted, "aborted"),
                    accept_error(ErrorKind::ConnectionReset, "reset"),
                    accept_error(ErrorKind::Interrupted, "interrupted"),
                    Ok(accepted_stream()),
                ]
                .into(),
            )),
            supervisor: Arc::clone(&supervisor),
        };
        let results = Arc::clone(&scripted.results);
        let started = tokio::time::Instant::now();
        serve(&supervisor, Box::new(scripted))
            .await
            .expect("the loop must survive recoverable accept errors");
        assert!(
            started.elapsed() < BACKOFF,
            "recoverable errors retry immediately, no backoff (elapsed {:?})",
            started.elapsed()
        );
        assert!(
            results.lock().unwrap().is_empty(),
            "the loop kept accepting past every error and served a client"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn recoverable_error_storms_back_off_but_never_escalate() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let mut results = VecDeque::new();
        for _ in 0..(2 * GIVE_UP_AFTER) {
            results.push_back(accept_error(ErrorKind::ConnectionAborted, "storm"));
        }
        results.push_back(Ok(accepted_stream()));
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(results)),
            supervisor: Arc::clone(&supervisor),
        };
        let results = Arc::clone(&scripted.results);
        let started = tokio::time::Instant::now();
        serve(&supervisor, Box::new(scripted))
            .await
            .expect("a recoverable storm must never exit the loop");
        let elapsed = started.elapsed();
        let storms = (2 * GIVE_UP_AFTER) / RECOVERABLE_STORM_AFTER;
        assert!(
            elapsed >= storms * BACKOFF,
            "every {RECOVERABLE_STORM_AFTER} consecutive recoverable errors back off (elapsed {elapsed:?})"
        );
        assert!(
            elapsed < (storms + 1) * BACKOFF,
            "exactly one backoff per storm (elapsed {elapsed:?})"
        );
        assert!(
            results.lock().unwrap().is_empty(),
            "the client behind the storm was served"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn non_recoverable_accept_errors_back_off_and_keep_serving() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(
                vec![
                    accept_error(ErrorKind::Other, "too many open files"),
                    Ok(accepted_stream()),
                ]
                .into(),
            )),
            supervisor: Arc::clone(&supervisor),
        };
        let results = Arc::clone(&scripted.results);
        let started = tokio::time::Instant::now();
        serve(&supervisor, Box::new(scripted))
            .await
            .expect("one hard error must not exit the loop");
        let elapsed = started.elapsed();
        assert!(
            elapsed >= BACKOFF,
            "the loop applied the backoff (elapsed {elapsed:?})"
        );
        assert!(
            elapsed < 2 * BACKOFF,
            "exactly one backoff for one error (elapsed {elapsed:?})"
        );
        assert!(
            results.lock().unwrap().is_empty(),
            "the loop kept serving after the error"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_served_connection_resets_the_give_up_budget() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let burst = GIVE_UP_AFTER - 1;
        let mut results = VecDeque::new();
        for _ in 0..burst {
            results.push_back(accept_error(ErrorKind::Other, "transient"));
        }
        results.push_back(Ok(accepted_stream()));
        for _ in 0..burst {
            results.push_back(accept_error(ErrorKind::Other, "transient"));
        }
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(results)),
            supervisor: Arc::clone(&supervisor),
        };
        let results = Arc::clone(&scripted.results);
        serve(&supervisor, Box::new(scripted))
            .await
            .expect("two sub-budget bursts with a served client between them never escalate");
        assert!(
            results.lock().unwrap().is_empty(),
            "every scripted accept was served"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn permanent_accept_failure_escalates_after_the_budget() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        // The script overflows the budget so the exact stop point is
        // observable in what the loop left unconsumed.
        let overflow = 40;
        let mut results = VecDeque::new();
        for _ in 0..(GIVE_UP_AFTER + overflow) {
            results.push_back(accept_error(ErrorKind::Other, "listener broken"));
        }
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(results)),
            supervisor: Arc::clone(&supervisor),
        };
        let results = Arc::clone(&scripted.results);
        let error = serve(&supervisor, Box::new(scripted))
            .await
            .expect_err("a permanently broken listener must escalate");
        assert_eq!(
            error.to_string(),
            "supervisor accept: listener broken",
            "the escalation carries the transport error"
        );
        assert_eq!(
            results.lock().unwrap().len(),
            overflow as usize,
            "the loop gave up at exactly the budget"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn accept_errors_while_shutting_down_do_not_back_off_or_escalate() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        supervisor.shutting_down.store(true, Ordering::SeqCst);
        let mut results = VecDeque::new();
        for _ in 0..(GIVE_UP_AFTER + 40) {
            results.push_back(accept_error(ErrorKind::Other, "shutting down"));
        }
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(results)),
            supervisor: Arc::clone(&supervisor),
        };
        let results = Arc::clone(&scripted.results);
        let started = tokio::time::Instant::now();
        serve(&supervisor, Box::new(scripted))
            .await
            .expect("shutdown-window errors never escalate");
        assert!(
            started.elapsed() < BACKOFF,
            "no backoff during the shutdown window (elapsed {:?})",
            started.elapsed()
        );
        assert!(
            results.lock().unwrap().is_empty(),
            "every error continued immediately"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_shutdown_wake_ends_the_backoff_early() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let scripted = ScriptedAccepts {
            results: Arc::new(Mutex::new(
                vec![accept_error(ErrorKind::Other, "hard error")].into(),
            )),
            supervisor: Arc::clone(&supervisor),
        };
        // The terminal wake fires mid-backoff: after a 100ms pause the exit flag and
        // its notify arrive, exactly like `begin_shutdown` finishing its stop pass.
        let shutting_down = Arc::clone(&supervisor);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            shutting_down.accept_exit.store(true, Ordering::SeqCst);
            shutting_down.shutdown_notify.notify_one();
        });
        let started = tokio::time::Instant::now();
        serve(&supervisor, Box::new(scripted))
            .await
            .expect("the shutdown wake ends the loop");
        assert!(
            started.elapsed() < BACKOFF,
            "the backoff ended at the wake, not the full second (elapsed {:?})",
            started.elapsed()
        );
    }
}
