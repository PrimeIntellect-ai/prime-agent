//! Shutdown and signal handling: the drain arms, the shutdown entry, and the
//! daemon-closing shutdown event.
use super::{json, Arc, Ordering, RouteAdmission, Supervisor, Value, ROUTE_TIMEOUT_MS};
// The only use is the broadcast inside the unix begin_signal_drain arm.
#[cfg(unix)]
use super::ClientRouting;
// The only use sits behind the unix update-drain arm below.
#[cfg(unix)]
use super::PrepareState;

/// The non-update `daemon_closing` frame: every connected client learns the daemon is
/// going down for a shutdown.
pub(super) fn daemon_closing_shutdown_event() -> Value {
    json!({ "type": "daemon_closing", "reason": "shutdown" })
}

impl Supervisor {
    /// Run the one terminal stop pass, whichever connection first reaches it: the stop
    /// must still start even if the initiating client disconnects. `shutdown_started`
    /// is the one-owner gate.
    pub(super) async fn ensure_shutdown_started(self: &Arc<Self>) {
        if self.shutdown_started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.begin_shutdown().await;
    }

    pub(super) async fn begin_shutdown(self: &Arc<Self>) {
        self.shutting_down.store(true, Ordering::SeqCst);
        for resident in self.registry.list().await {
            resident.intentional_stop.store(true, Ordering::SeqCst);
            resident.note_retired();
            // The stop tombstone persists before the worker is even told (TS
            // `stopWorkerUntracked`): a supervisor that dies between here and the worker's
            // exit leaves durable stop intent, and the next boot finishes the stop.
            if self.persist_stop_tombstone(&resident).await.is_err() {
                self.log_line(&format!(
                    "session worker {} stop tombstone could not persist; leaving the worker untouched (the next boot retries the stop)",
                    resident.worker_id
                ));
                continue;
            }
            let _ = self
                .route_command_typed(
                    &resident,
                    "shutdown",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::SupervisorInternal,
                )
                .await;
            self.retire_worker_after_stop(&resident).await;
        }
        self.registry.clear().await;
        // The workers are all stopped now, so the accept loop may exit; the gate alone
        // is not enough — an inbound connection could fall the loop out mid-stop.
        self.accept_exit.store(true, Ordering::SeqCst);
        // Both accept loops (unix + the tailnet TCP listener) wait on this
        // notify: waking every waiter releases the mesh listener with the
        // unix one (the loop-top flag checks make a spurious wake a no-op).
        self.shutdown_notify.notify_waiters();
    }

    /// The OS-signal drain step (the loop in `crate::signal_drain` runs this once per
    /// signal): the first signal enters the graceful drain; any later signal, or one
    /// that finds a shutdown or update exit already committed, force-exits. Returns
    /// `true` when this call started the drain; `false` when one was already in flight.
    /// A signal that finds `Stopping` or `accept_exit` published never flips the gate.
    #[cfg(unix)]
    pub(crate) fn begin_signal_drain(self: &Arc<Self>) -> bool {
        if self.update_prepare.active_state() == Some(PrepareState::Stopping)
            || self.accept_exit.load(Ordering::SeqCst)
            || self.shutting_down.swap(true, Ordering::SeqCst)
        {
            return false;
        }
        self.log_line(
            "received shutdown signal; entering graceful drain: new client commands refused, running turns settle through the workers' routed shutdown",
        );
        let _ = self.events.send((
            ClientRouting::Broadcast,
            std::sync::Arc::new(daemon_closing_shutdown_event()),
        ));
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            supervisor.ensure_shutdown_started().await;
        });
        true
    }
}
