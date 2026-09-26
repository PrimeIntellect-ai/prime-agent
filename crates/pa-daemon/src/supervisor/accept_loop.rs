//! The supervisor's client accept loop: transient accept errors warn
//! and retry instead of killing the process.
//!
//! The pre-fix loop returned any accept error out of `run`, and the
//! process exit orphaned every hosted session's worker into the
//! five-minute supervisor-lost window. The error policy mirrors Codex's
//! control-socket acceptor (`run_control_socket_acceptor` in
//! `app-server-transport/src/transport/unix_socket.rs`): recoverable
//! transport noise warns and retries immediately, and every other error
//! logs and retries after a backoff. Codex retries forever; here the
//! retries are bounded by [`GIVE_UP_AFTER`] consecutive failures,
//! because this supervisor owns the socket-path singleton: a listener
//! that failed every accept for a solid minute is permanently broken,
//! and exiting with the error (the pre-fix path) releases the bind for
//! a fresh supervisor instead of spinning deaf forever.

use std::io::ErrorKind;
use std::time::Duration;

use pa_types::platform::transport::TransportListener;

use super::*;

/// The backoff before retrying a non-recoverable accept error (Codex
/// parity: the control-socket acceptor sleeps 1s between retries).
pub(super) const BACKOFF: Duration = Duration::from_secs(1);

/// Consecutive non-recoverable accept failures the loop survives; the
/// [`GIVE_UP_AFTER`]-th escalates the transport error out of `run` (the
/// pre-fix exit path).
///
/// Sixty 1s-backoff retries keep the supervisor alive through transient
/// fd-pressure storms, while a listener that failed every accept for a
/// solid minute is permanently broken: a deaf supervisor holding the
/// socket-path bind singleton is worse than a dead one - it blocks a
/// fresh supervisor from serving the socket. Any accepted connection
/// resets the count; recoverable transport noise neither spends nor
/// resets it.
pub(super) const GIVE_UP_AFTER: u32 = 60;

/// Serve clients until `begin_shutdown` completes its stop pass and
/// sets the accept-loop exit flag.
///
/// # Errors
///
/// Returns the transport's accept error once [`GIVE_UP_AFTER`]
/// consecutive non-recoverable accept failures exhaust the give-up
/// budget; the caller exits the process, releasing the socket bind.
pub(super) async fn serve(
    supervisor: &Arc<Supervisor>,
    listener: &dyn TransportListener,
) -> Result<()> {
    let mut consecutive_failures = 0u32;
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
                        continue;
                    }
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
                    tokio::time::sleep(BACKOFF).await;
                    continue;
                }
            },
            // begin_shutdown fired: loop back and fall out of the loop.
            () = supervisor.shutdown_notify.notified() => continue,
        };
        consecutive_failures = 0;
        let supervisor = Arc::clone(supervisor);
        tokio::spawn(async move {
            if let Err(error) = supervisor.handle_client(stream).await {
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

    use pa_types::platform::transport::{AcceptFuture, TransportStream};
    use tempfile::TempDir;

    use crate::supervisor::{Supervisor, SupervisorOptions};

    use super::*;

    /// A stand-in transport listener that replays a scripted accept
    /// sequence. When the script drains, the stand-in runs the
    /// supervisor's shutdown wake (the accept-loop exit flag plus the
    /// notify) and parks: `serve` falls out of its loop exactly the way
    /// a real listener does once `begin_shutdown` completes.
    struct ScriptedAccepts {
        results: Mutex<VecDeque<io::Result<Box<dyn TransportStream>>>>,
        supervisor: Arc<Supervisor>,
    }

    impl TransportListener for ScriptedAccepts {
        fn accept(&self) -> AcceptFuture<'_> {
            Box::pin(async move {
                match self.results.lock().unwrap().pop_front() {
                    Some(result) => result,
                    None => {
                        self.supervisor.accept_exit.store(true, Ordering::SeqCst);
                        self.supervisor.shutdown_notify.notify_one();
                        std::future::pending::<io::Result<Box<dyn TransportStream>>>().await
                    }
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
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .expect("supervisor"),
        )
    }

    /// One end of a local socket pair as the accepted stream: the
    /// dispatch writes its hello and parks on the unread peer, like an
    /// idle client.
    async fn accepted_stream() -> Box<dyn TransportStream> {
        let (_, accepted) = tokio::net::UnixStream::pair().expect("socket pair");
        Box::new(accepted)
    }

    /// A recoverable transport error must not exit the accept loop (the
    /// pre-fix behavior killed the supervisor - and every hosted
    /// session's supervision - on the first one), and it must not burn
    /// the backoff: the loop retries immediately, like Codex's
    /// control-socket acceptor.
    #[tokio::test(start_paused = true)]
    async fn recoverable_accept_errors_do_not_exit_the_loop() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let scripted = ScriptedAccepts {
            results: Mutex::new(
                vec![
                    accept_error(ErrorKind::ConnectionAborted, "aborted"),
                    accept_error(ErrorKind::ConnectionReset, "reset"),
                    accept_error(ErrorKind::Interrupted, "interrupted"),
                    Ok(accepted_stream().await),
                ]
                .into(),
            ),
            supervisor: Arc::clone(&supervisor),
        };
        let started = tokio::time::Instant::now();
        serve(&supervisor, &scripted)
            .await
            .expect("the loop must survive recoverable accept errors");
        assert!(
            started.elapsed() < BACKOFF,
            "recoverable errors retry immediately, no backoff (elapsed {:?})",
            started.elapsed()
        );
        assert!(
            scripted.results.lock().unwrap().is_empty(),
            "the loop kept accepting past every error and served a client"
        );
    }

    /// A non-recoverable accept error (fd pressure, kernel buffer
    /// exhaustion) must back off and keep serving: the scripted client
    /// behind it is accepted after exactly one backoff.
    #[tokio::test(start_paused = true)]
    async fn non_recoverable_accept_errors_back_off_and_keep_serving() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let scripted = ScriptedAccepts {
            results: Mutex::new(
                vec![
                    accept_error(ErrorKind::Other, "too many open files"),
                    Ok(accepted_stream().await),
                ]
                .into(),
            ),
            supervisor: Arc::clone(&supervisor),
        };
        let started = tokio::time::Instant::now();
        serve(&supervisor, &scripted)
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
            scripted.results.lock().unwrap().is_empty(),
            "the loop kept serving after the error"
        );
    }

    /// The give-up budget counts consecutive failures: a served
    /// connection between two sub-budget bursts resets it, so a
    /// repeating transient error with live client traffic never
    /// escalates.
    #[tokio::test(start_paused = true)]
    async fn a_served_connection_resets_the_give_up_budget() {
        let dir = TempDir::new().unwrap();
        let supervisor = test_supervisor(&dir);
        let burst = GIVE_UP_AFTER - 1;
        let mut results = VecDeque::new();
        for _ in 0..burst {
            results.push_back(accept_error(ErrorKind::Other, "transient"));
        }
        results.push_back(Ok(accepted_stream().await));
        for _ in 0..burst {
            results.push_back(accept_error(ErrorKind::Other, "transient"));
        }
        let scripted = ScriptedAccepts {
            results: Mutex::new(results),
            supervisor: Arc::clone(&supervisor),
        };
        serve(&supervisor, &scripted)
            .await
            .expect("two sub-budget bursts with a served client between them never escalate");
        assert!(
            scripted.results.lock().unwrap().is_empty(),
            "every scripted accept was served"
        );
    }

    /// A listener that failed every accept for the whole give-up budget
    /// is permanently broken: the loop escalates the transport error
    /// (the pre-fix exit) so the process releases the singleton socket
    /// bind for a fresh supervisor - and it stops at exactly the
    /// budget, neither earlier nor later.
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
            results: Mutex::new(results),
            supervisor: Arc::clone(&supervisor),
        };
        let error = serve(&supervisor, &scripted)
            .await
            .expect_err("a permanently broken listener must escalate");
        assert_eq!(
            error.to_string(),
            "supervisor accept: listener broken",
            "the escalation carries the transport error"
        );
        assert_eq!(
            scripted.results.lock().unwrap().len(),
            overflow as usize,
            "the loop gave up at exactly the budget"
        );
    }

    /// During the terminal stop pass the loop is exiting by flag, not by
    /// error: accept errors in that window neither back off nor spend
    /// the give-up budget.
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
            results: Mutex::new(results),
            supervisor: Arc::clone(&supervisor),
        };
        let started = tokio::time::Instant::now();
        serve(&supervisor, &scripted)
            .await
            .expect("shutdown-window errors never escalate");
        assert!(
            started.elapsed() < BACKOFF,
            "no backoff during the shutdown window (elapsed {:?})",
            started.elapsed()
        );
        assert!(
            scripted.results.lock().unwrap().is_empty(),
            "every error continued immediately"
        );
    }
}
