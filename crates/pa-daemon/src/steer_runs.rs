//! Per-steer turn-settle tracking: the ACP steering layer registers a
//! `runId` with each admitted steer, the queued item carries the settle
//! sender, and the ACP layer waits for (or probes) the run's outcome.
//! The registry keeps the settled outcome so a later probe still answers.

use std::collections::HashMap;

use tokio::sync::{oneshot, Notify};

use crate::worker::TurnSettle;

/// The registry entry: the run's pending settle receiver (taken by the
/// waiter), or the settle once it arrived (`None` = the item was
/// withdrawn without running).
enum SteerRunSlot {
    Pending(Option<oneshot::Receiver<TurnSettle>>),
    Settled(Option<TurnSettle>),
}

/// The outcome of one probe: `Running` while the item is queued or its
/// turn is in flight, the settle once the run resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SteerRunProbe {
    Running,
    Settled(Option<TurnSettle>),
}

pub(crate) struct SteerRunTable {
    runs: std::sync::Mutex<HashMap<String, SteerRunSlot>>,
    /// Wakes a parked waiter when another waiter stored a settle.
    settles: Notify,
}

impl SteerRunTable {
    pub(crate) fn new() -> SteerRunTable {
        SteerRunTable {
            runs: std::sync::Mutex::new(HashMap::new()),
            settles: Notify::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SteerRunSlot>> {
        self.runs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Register one steered run: the returned sender rides the queued
    /// item's `done` and resolves the run at its turn's settle. A dropped
    /// sender (the item was withdrawn before delivery) resolves the run
    /// as `Settled(None)` on the next wait or probe.
    pub(crate) fn register(&self, run_id: &str) -> oneshot::Sender<TurnSettle> {
        let (sender, receiver) = oneshot::channel();
        self.lock()
            .insert(run_id.to_string(), SteerRunSlot::Pending(Some(receiver)));
        sender
    }

    /// The settle of one registered run, waiting for the run's turn to
    /// settle. `None` = unknown run id.
    pub(crate) async fn wait(&self, run_id: &str) -> Option<Option<TurnSettle>> {
        loop {
            let receiver = match self.lock().get_mut(run_id)? {
                SteerRunSlot::Settled(settled) => return Some(settled.clone()),
                SteerRunSlot::Pending(receiver) => receiver.take(),
            };
            let Some(receiver) = receiver else {
                // Another waiter owns the settle: park until it stores
                // it. Only an already-stored settle re-checks without
                // parking - a taken-but-unsettled slot must wait on the
                // notify, never spin on the lock.
                let notified = self.settles.notified();
                if self
                    .lock()
                    .get(run_id)
                    .is_some_and(|slot| matches!(slot, SteerRunSlot::Settled(_)))
                {
                    continue;
                }
                notified.await;
                continue;
            };
            let settled = receiver.await.ok();
            self.lock()
                .insert(run_id.to_string(), SteerRunSlot::Settled(settled.clone()));
            self.settles.notify_waiters();
            return Some(settled);
        }
    }

    /// The non-blocking read: `Running` while the run's turn has not
    /// settled, the settle once it has. A settle observed by a probe is
    /// kept for later probes and waits. `None` = unknown run id.
    pub(crate) fn probe(&self, run_id: &str) -> Option<SteerRunProbe> {
        let mut runs = self.lock();
        let slot = runs.get_mut(run_id)?;
        match slot {
            SteerRunSlot::Settled(settled) => Some(SteerRunProbe::Settled(settled.clone())),
            SteerRunSlot::Pending(None) => Some(SteerRunProbe::Running),
            SteerRunSlot::Pending(Some(receiver)) => match receiver.try_recv() {
                Ok(settled) => {
                    let settled = Some(settled);
                    *slot = SteerRunSlot::Settled(settled.clone());
                    self.settles.notify_waiters();
                    Some(SteerRunProbe::Settled(settled))
                }
                Err(oneshot::error::TryRecvError::Empty) => Some(SteerRunProbe::Running),
                Err(oneshot::error::TryRecvError::Closed) => {
                    *slot = SteerRunSlot::Settled(None);
                    self.settles.notify_waiters();
                    Some(SteerRunProbe::Settled(None))
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_registered_run_resolves_through_wait_and_later_probes() {
        let table = SteerRunTable::new();
        let sender = table.register("run-1");
        assert!(
            matches!(table.probe("run-1"), Some(SteerRunProbe::Running)),
            "an in-flight run probes as running"
        );
        sender
            .send(TurnSettle::Completed)
            .expect("the settle lands");
        assert_eq!(
            table.wait("run-1").await,
            Some(Some(TurnSettle::Completed)),
            "the wait resolves the run"
        );
        assert_eq!(
            table.probe("run-1"),
            Some(SteerRunProbe::Settled(Some(TurnSettle::Completed))),
            "a later probe still answers the kept settle"
        );
    }

    #[tokio::test]
    async fn a_withdrawn_run_settles_as_never_run() {
        let table = SteerRunTable::new();
        let sender = table.register("run-2");
        drop(sender);
        assert_eq!(
            table.probe("run-2"),
            Some(SteerRunProbe::Settled(None)),
            "a dropped settle sender is a withdrawn run"
        );
        assert_eq!(
            table.wait("run-2").await,
            Some(None),
            "the wait answers the same withdrawal"
        );
    }

    #[tokio::test]
    async fn a_second_wait_parks_until_the_owning_wait_stores_the_settle() {
        let table = std::sync::Arc::new(SteerRunTable::new());
        let sender = table.register("run-3");
        let first = {
            let table = std::sync::Arc::clone(&table);
            async move { table.wait("run-3").await }
        };
        let second = {
            let table = std::sync::Arc::clone(&table);
            async move { table.wait("run-3").await }
        };
        let first = tokio::spawn(first);
        let second = tokio::spawn(second);
        // Both waits park on the unsettled run (the owning one on the
        // receiver, the second on the settle notify), and neither
        // resolves before the settle fires.
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            !second.is_finished(),
            "the second wait parks on the notify, it does not spin or resolve early"
        );
        sender
            .send(TurnSettle::Failed("boom".to_string()))
            .expect("the settle lands");
        assert_eq!(
            first.await.unwrap(),
            Some(Some(TurnSettle::Failed("boom".to_string()))),
            "the owning wait resolves the settle"
        );
        assert_eq!(
            second.await.unwrap(),
            Some(Some(TurnSettle::Failed("boom".to_string()))),
            "the parked second wait answers the stored settle"
        );
    }

    #[tokio::test]
    async fn a_second_wait_answers_an_already_stored_settle() {
        let table = SteerRunTable::new();
        let sender = table.register("run-4");
        drop(sender);
        let first = {
            let table = &table;
            async move { table.wait("run-4").await }
        };
        let second = {
            let table = &table;
            async move { table.wait("run-4").await }
        };
        let (a, b) = tokio::join!(first, second);
        assert_eq!(
            a,
            Some(None),
            "the owning wait resolves the dropped sender as withdrawn"
        );
        assert_eq!(
            b,
            Some(None),
            "the second wait answers the stored withdrawal, never hangs"
        );
    }

    #[tokio::test]
    async fn an_unknown_run_id_answers_nothing() {
        let table = SteerRunTable::new();
        assert_eq!(table.probe("nope"), None);
        assert_eq!(table.wait("nope").await, None);
    }
}
