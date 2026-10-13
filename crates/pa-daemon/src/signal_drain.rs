//! The supervisor's OS-signal drain loop (SIGTERM/SIGINT).
//!
//! [`Supervisor::begin_signal_drain`] is the state machine: the first signal enters
//! the graceful drain (work refused at the gates, running turns settled by each
//! worker's routed `shutdown` flush barrier); a later signal — or one that finds
//! a shutdown already in flight — forces the exit, skipping teardown entirely
//! (runtime teardown can wait forever on blocked worker I/O).
//! [`install`] registers the handlers right after the socket binds.

use std::sync::Arc;
#[cfg(unix)]
use tokio::signal::unix::{signal, Signal, SignalKind};

use crate::supervisor::Supervisor;

/// Install the SIGTERM/SIGINT handlers and return the drain loop that
/// serves them; the loop exits when neither handler could register.
#[cfg(unix)]
pub(crate) fn install(supervisor: Arc<Supervisor>) -> impl std::future::Future<Output = ()> + Send {
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(terminate) => Some(terminate),
        Err(error) => {
            supervisor.log_line(&format!(
                "signal drain could not install the SIGTERM handler ({error}); SIGTERM keeps the default disposition"
            ));
            None
        }
    };
    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(interrupt) => Some(interrupt),
        Err(error) => {
            supervisor.log_line(&format!(
                "signal drain could not install the SIGINT handler ({error}); SIGINT keeps the default disposition"
            ));
            None
        }
    };
    async move {
        if terminate.is_none() && interrupt.is_none() {
            return;
        }
        loop {
            tokio::select! {
                () = recv_opt(terminate.as_mut()) => {}
                () = recv_opt(interrupt.as_mut()) => {}
            }
            if !supervisor.begin_signal_drain() {
                supervisor
                    .log_line("received shutdown signal while already shutting down; forcing exit");
                // Forced exit skips teardown: a worker wedged in its settle
                // must not hold the operator's second demand hostage.
                std::process::exit(0);
            }
        }
    }
}

/// Wait on one optional signal stream: an absent stream (a registration
/// failure) parks forever instead of spinning the loop.
#[cfg(unix)]
async fn recv_opt(stream: Option<&mut Signal>) {
    match stream {
        Some(stream) => {
            let _ = stream.recv().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// A detached Windows supervisor has no unix signal source and no console `ctrl_c`
/// either: the managed stop stays the only lifecycle path.
#[cfg(not(unix))]
pub(crate) fn install(
    _supervisor: Arc<Supervisor>,
) -> impl std::future::Future<Output = ()> + Send {
    std::future::pending::<()>()
}
