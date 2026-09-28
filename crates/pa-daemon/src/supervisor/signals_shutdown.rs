//! Shutdown and signal handling: the drain arms, the shutdown entry, and the
//! daemon-closing shutdown event.
use super::{clients};

/// The non-update `daemon_closing` frame (the shutdown command's and the
/// OS-signal drain's shared spelling): every connected client learns the
/// daemon is going down for a shutdown, the spelling the TUI reconnects
/// attached windows on.
pub(super) fn daemon_closing_shutdown_event() -> Value {
    json!({ "type": "daemon_closing", "reason": "shutdown" })
}

impl Supervisor {
    /// Run the one terminal stop pass, whichever connection first reaches it.
    ///
    /// The shutdown command sets `shutting_down` synchronously, but the stop
    /// pass still has to start even if its initiating client disconnects or
    /// the response write fails. `shutdown_started` is the one-owner gate:
    /// the first caller runs `begin_shutdown`; every later observer returns
    /// immediately instead of duplicating the worker stops.
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
            // `stopWorkerUntracked` persists before its request): a
            // supervisor that dies between here and the worker's exit
            // leaves durable stop intent, and the next boot finishes the
            // stop instead of adopting the leftover as healthy.
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
        // The workers are all stopped now, so the accept loop may exit;
        // setting the gate alone is not enough — an inbound connection
        // could otherwise fall the loop out mid-stop.
        self.accept_exit.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_one();
    }

    /// The OS-signal drain step (SIGTERM/SIGINT; the loop in
    /// `crate::signal_drain` runs this once per received signal): the
    /// first signal enters the graceful drain, and any later signal - or
    /// one that finds a client-command shutdown or an update restart
    /// already committed to its exit - force-exits instead.
    ///
    /// The gate flips synchronously, so from this moment every later
    /// client command is refused at the dispatch gate and every create
    /// at the launch gate; the connected clients get the same
    /// `daemon_closing` event the shutdown command broadcasts. The
    /// terminal stop pass then runs in the background
    /// ([`Self::ensure_shutdown_started`]): each resident worker gets its
    /// routed `shutdown` - the worker's handler is the flush barrier, so
    /// the in-flight turn aborts and settles before the worker exits -
    /// and a worker that misses the route gets the identity-gated
    /// SIGTERM → SIGKILL escalation instead of lingering in the
    /// supervisor-lost window.
    ///
    /// Returns `true` when this call started the drain (the signal loop
    /// keeps waiting for the force signal); `false` when a drain or exit
    /// was already in flight (the caller is the forced exit). The update
    /// restart's exit windows are guarded on both ends: a signal that
    /// finds the coordinator in `Stopping` (workers already being stopped
    /// with their descriptors kept for the successor) or `accept_exit`
    /// already published never flips the shutdown gate, so it cannot
    /// convert the descriptor-preserving update exit into a terminal
    /// stop pass.
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
