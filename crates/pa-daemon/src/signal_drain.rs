//! The supervisor's OS-signal drain loop (SIGTERM/SIGINT): the Codex
//! app-server's `shutdown_signal` + `ShutdownState` structure
//! (codex-rs/app-server/src/lib.rs) adapted to the multi-worker supervisor.
//!
//! [`Supervisor::begin_signal_drain`] is the state machine: the first
//! signal enters the graceful drain (new work refused at the gates, every
//! client told the daemon is closing, the running turns settled by each
//! worker's routed `shutdown` flush barrier, the workers retired so
//! nothing lingers in the supervisor-lost window); a later signal - or one
//! that finds a client-command shutdown, a committed update stop, or an
//! update exit already in flight - is the force request, and the forced
//! exit skips teardown entirely: runtime teardown can wait forever on
//! blocked worker I/O (the Codex `AppServerExit::Forced` rationale,
//! app-server/src/main.rs).
//!
//! [`install`] registers the handlers synchronously (the run loop calls it
//! directly after the socket binds, before its next await) and returns the
//! loop that serves them: a signal cannot land in a spawn-to-first-poll
//! window with the default disposition still active. A handler that fails
//! to register is logged and dropped while the other signal keeps
//! draining; dropping a registered listener would strand its signal
//! (tokio keeps the replacement disposition installed after the listener
//! is gone, so a dropped stream swallows every later delivery).

use std::sync::Arc;

use tokio::signal::unix::{signal, Signal, SignalKind};

use crate::supervisor::Supervisor;

/// Install the SIGTERM/SIGINT handlers and return the drain loop that
/// serves them ([`Supervisor::run`] spawns it). Returns a loop that exits
/// immediately when neither handler could register: with no listener, the
/// signals keep their default disposition.
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
async fn recv_opt(stream: Option<&mut Signal>) {
    match stream {
        Some(stream) => {
            let _ = stream.recv().await;
        }
        None => std::future::pending::<()>().await,
    }
}

/// A detached Windows supervisor has no unix signal source and no console
/// `ctrl_c` either (the Codex app-server keeps its fallback pending for
/// the same reason): the managed stop stays the only lifecycle path.
#[cfg(not(unix))]
pub(crate) fn install(
    _supervisor: Arc<Supervisor>,
) -> impl std::future::Future<Output = ()> + Send {
    std::future::pending::<()>()
}
