//! Shutdown-signal registration for the interactive client (TS
//! `registerSignalHandlers`, interactive-mode.ts: SIGTERM shuts the run
//! down gracefully, SIGHUP takes the emergency exit - the terminal is
//! closing, so no restore sequence may run).
//!
//! The registration lives for the rest of the process: a signal after the
//! chat loop ended (the agents-view handoff, or the exit teardown) must
//! still terminate the process, exactly like TS's handler outliving one
//! mode's teardown. `tokio` signal streams keep their dispositions
//! installed once registered, so an unregistered process would silently
//! swallow the signal instead.

use tokio::sync::mpsc;

use pa_types::platform::kill_tracked_detached_children;

/// The graceful-leave notice a signal delivered to the chat loop (SIGTERM,
/// TS `killTrackedDetachedChildren` + `void shutdown()`).
pub(crate) enum SignalExit {
    Sigterm,
}

/// Register the client's shutdown-signal handlers (TS
/// `registerSignalHandlers`): SIGTERM kills the tracked detached children
/// and asks the loop for a graceful leave; SIGHUP kills them and takes the
/// emergency exit (the terminal is going away with the signal). After the
/// loop is gone, a SIGTERM restores the terminal best-effort and exits 143
/// — the default-disposition death TS's unregistered surfaces show, so a
/// handed-off process still terminates on the signal.
#[cfg(unix)]
pub(crate) fn register(exit_tx: mpsc::UnboundedSender<SignalExit>) {
    tokio::spawn(async move {
        let Ok(mut sigterm) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return;
        };
        let Ok(mut sighup) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        else {
            return;
        };
        loop {
            tokio::select! {
                _ = sigterm.recv() => {
                    kill_tracked_detached_children();
                    if exit_tx.send(SignalExit::Sigterm).is_err() {
                        // The chat loop is gone: the process either handed
                        // the pane off or is already in its exit teardown.
                        // Terminate now like the default disposition would
                        // (the exit watchdog covers a wedged teardown the
                        // same way TS's handler resolves to a process exit).
                        crate::exit_guard::force_quit_with_code(143);
                    }
                }
                _ = sighup.recv() => {
                    kill_tracked_detached_children();
                    crate::exit_guard::emergency_terminal_exit();
                }
            }
        }
    });
}

#[cfg(not(unix))]
pub(crate) fn register(_exit_tx: mpsc::UnboundedSender<SignalExit>) {
    // TS registers SIGTERM on win32 too, but a win32 console client never
    // receives one outside `taskkill` (which TerminateProcess-es anyway);
    // the suspend shield owns SIGINT there. No registration matches the
    // observable behavior.
}
