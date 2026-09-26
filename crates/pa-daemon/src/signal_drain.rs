//! The supervisor's OS-signal drain loop (SIGTERM/SIGINT): the Codex
//! app-server's `shutdown_signal` + `ShutdownState` structure
//! (codex-rs/app-server/src/lib.rs) adapted to the multi-worker supervisor.
//!
//! [`Supervisor::begin_signal_drain`] is the state machine: the first
//! signal enters the graceful drain (new work refused at the gates, every
//! client told the daemon is closing, the running turns settled by each
//! worker's routed `shutdown` flush barrier, the workers retired so
//! nothing lingers in the supervisor-lost window); a later signal - or one
//! that finds a client-command shutdown or an update exit already in
//! flight - is the force request, and the forced exit skips teardown
//! entirely: runtime teardown can wait forever on blocked worker I/O (the
//! Codex `AppServerExit::Forced` rationale, app-server/src/main.rs).
//!
//! The handlers install only once the accept loop is up ([`Supervisor::run`]
//! spawns this loop after the socket binds): a signal during boot keeps
//! today's default disposition, exactly like before this loop existed.

use std::sync::Arc;

use crate::supervisor::Supervisor;

/// Wait for SIGTERM/SIGINT and drive the supervisor's drain step: the
/// first signal drains, a later one force-exits. Runs for the process's
/// whole serving life - the accept loop's normal exit ends the process
/// with it.
#[cfg(unix)]
pub(crate) async fn run_signal_drain(supervisor: Arc<Supervisor>) {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(terminate) => terminate,
        Err(error) => {
            supervisor.log_line(&format!(
                "signal drain could not install the SIGTERM handler ({error}); signals keep the default disposition"
            ));
            return;
        }
    };
    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(interrupt) => interrupt,
        Err(error) => {
            supervisor.log_line(&format!(
                "signal drain could not install the SIGINT handler ({error}); signals keep the default disposition"
            ));
            return;
        }
    };
    loop {
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
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

/// A detached Windows supervisor has no unix signal source and no console
/// `ctrl_c` either (the Codex app-server keeps its fallback pending for
/// the same reason): the managed stop stays the only lifecycle path.
#[cfg(not(unix))]
pub(crate) async fn run_signal_drain(_supervisor: Arc<Supervisor>) {
    std::future::pending::<()>().await;
}
