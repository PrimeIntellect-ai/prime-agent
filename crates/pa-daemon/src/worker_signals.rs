//! Shutdown-signal handlers for the session worker (TS daemon-mode
//! `registerSignalHandlers`: SIGINT/SIGTERM/SIGHUP kill the tracked
//! detached children — the session's bash runs — then run the graceful
//! shutdown sequence and exit with the signal's conventional code).
//!
//! The Rust worker previously died on these signals by their default
//! dispositions, orphaning every detached bash child mid-run; the handler
//! preserves the default's immediacy (no socket waits) while draining the
//! tracked-child registry first.

use std::sync::Arc;

use pa_types::platform::kill_tracked_detached_children;

use crate::worker::Worker;

/// The conventional exit code for each signal (TS daemon-mode `shutdown`
/// argument: 128 + the signal number).
const SIGINT_EXIT: i32 = 130;
const SIGTERM_EXIT: i32 = 143;
const SIGHUP_EXIT: i32 = 129;

/// Register the worker's shutdown-signal handlers (TS daemon-mode
/// `registerSignalHandlers`, SIGINT/SIGTERM/SIGHUP). The task owns the
/// worker handle for the graceful sequence; the dispositions stay installed
/// for the rest of the process.
#[cfg(unix)]
pub(crate) fn register(worker: Arc<Worker>) {
    tokio::spawn(async move {
        let Ok(mut sigint) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        else {
            return;
        };
        let Ok(mut sigterm) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return;
        };
        let Ok(mut sighup) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        else {
            return;
        };
        // The handler never returns: the first signal observed runs the
        // shutdown and exits, so the loop body runs once (an `#[allow]` on a
        // real loop would only serve a second signal that can never be
        // observed — the process is gone by then).
        let code = tokio::select! {
            _ = sigint.recv() => SIGINT_EXIT,
            _ = sigterm.recv() => SIGTERM_EXIT,
            _ = sighup.recv() => SIGHUP_EXIT,
        };
        // TS daemon-mode kills the tracked detached children before the
        // graceful shutdown starts.
        kill_tracked_detached_children();
        worker.shutdown_sequence().await;
        // The graceful exit owns its socket file and keeps its resume
        // entry, exactly like the `shutdown` command's exit below the
        // reply.
        let _ = worker.record_recovery(false, "shutdown");
        crate::socket::cleanup_socket_path(
            &worker.config.socket_path,
            crate::socket::socket_identity(&worker.config.socket_path),
        );
        std::process::exit(code);
    });
}

#[cfg(not(unix))]
pub(crate) fn register(_worker: Arc<Worker>) {
    // The win32 worker has no POSIX signals; the supervisor's stop path
    // (the `shutdown` command, then TerminateProcess) covers the same
    // lifecycle.
}
