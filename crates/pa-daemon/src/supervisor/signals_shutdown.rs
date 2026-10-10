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
        let mut prepared = Vec::new();
        let mut residents = self.registry.list().await;
        residents.sort_by(|left, right| left.worker_id.cmp(&right.worker_id));
        for resident in residents {
            // Persist the exact request and worker generation before dispatch. An ACK
            // can disappear after the worker has fsynced its queue checkpoint; only
            // this identity lets the next boot decide what actually happened.
            let attempt_id = uuid::Uuid::new_v4().to_string();
            let persisted = {
                let mut current = resident.descriptor.lock().await;
                let worker_instance_id = current.worker_instance_id.clone();
                match worker_instance_id.filter(|id| !id.is_empty()) {
                    None => Err(anyhow::anyhow!("worker generation is missing")),
                    Some(worker_instance_id) => {
                        let mut next = current.clone();
                        next.rest.insert(
                            crate::descriptor::SHUTDOWN_HOLD_KEY.into(),
                            json!(crate::descriptor::ShutdownHold::new(
                                attempt_id.clone(),
                                worker_instance_id
                            )),
                        );
                        next.stop_requested_at = Some(crate::util::now_iso());
                        next.archive_on_stop = Some(false);
                        let result = crate::descriptor::persist_shutdown_boundary(
                            &resident.descriptor_path,
                            &next,
                        );
                        if result.is_ok() {
                            *current = next;
                        }
                        result
                    }
                }
            };
            if let Err(error) = persisted {
                self.log_line(&format!(
                    "session worker {} shutdown hold could not persist; graceful teardown aborted while the supervisor retains its live workers: {error:#}",
                    resident.worker_id,
                ));
                // Exiting here would drop the supervisor link. The worker's
                // orphan exit writes a generic idle row, and a later boot
                // could make a decision without this shutdown attempt.
                // None of the prepared workers has received shutdown yet.
                self.shutting_down.store(false, Ordering::SeqCst);
                self.shutdown_started.store(false, Ordering::SeqCst);
                *self.shutdown_owner.lock().unwrap() = None;
                return;
            }
            prepared.push((resident, attempt_id));
        }
        for (resident, attempt_id) in prepared {
            resident.intentional_stop.store(true, Ordering::SeqCst);
            resident.note_retired();
            let _ = self
                .route_command_typed(
                    &resident,
                    "shutdown",
                    json!({ "daemonShutdown": true, "shutdownAttemptId": attempt_id }),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::SupervisorInternal,
                )
                .await;
            self.retire_worker_after_stop(&resident, true).await;
        }
        self.registry.clear().await;
        // The workers are all stopped now, so the accept loop may exit; the gate alone
        // is not enough — an inbound connection could fall the loop out mid-stop.
        self.accept_exit.store(true, Ordering::SeqCst);
        self.shutdown_notify.notify_one();
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
