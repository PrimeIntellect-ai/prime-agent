//! The supervisor's update-prepare transaction: `Draining -> Fenced -> Snapshotted
//! -> Prepared -> Stopping`, with `Aborted -> Serving` as the recovery path of last resort.
//! A transaction with watchdogs (spec §2): expiry aborts, deletes the prepared artifacts, and
//! returns the supervisor to `Serving`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use pa_types::daemon::{
    is_daemon_mutating_command, is_update_drain_command, socket_update_dir,
    update_prepared_dir as prepared_dir_of, UpdateId, UpdatePreparedMarker, UpdateRoster,
    UpdateTimeoutBudget,
};
use tokio::sync::watch;
use tokio::time::Instant;

use crate::util::{iso_from_unix_ms, now_ms};

/// Wire names of the supervisor-side prepare states (TS `draining`/`prepared`
/// phases, extended with the spec's `fenced`/`snapshotted`/`stopping`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrepareState {
    /// Prepare accepted; waiting for in-flight mutations to drain.
    Draining,
    /// Mutations drained; a stable point to snapshot from.
    Fenced,
    /// Roster + marker written durably into `prepared/<update-id>/`.
    Snapshotted,
    /// The coordinator was acked; the marker's self-expiry is armed.
    Prepared,
    /// The coordinator consumed the roster; workers are stopping
    /// (graceful-stop budget - never a SIGKILL).
    Stopping,
}

impl PrepareState {
    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            PrepareState::Draining => "draining",
            PrepareState::Fenced => "fenced",
            PrepareState::Snapshotted => "snapshotted",
            PrepareState::Prepared => "prepared",
            PrepareState::Stopping => "stopping",
        }
    }

    /// Whether `prepared/<update-id>/` artifacts exist on disk for this
    /// state (written at `Snapshotted`, removed on expiry/abort).
    fn has_prepared_artifacts(self) -> bool {
        // `Stopping` still carries the artifacts written at `Snapshotted`:
        // an abandoned stop sweeps them like any other abort.
        matches!(
            self,
            PrepareState::Snapshotted | PrepareState::Prepared | PrepareState::Stopping
        )
    }
}

/// Why an active prepare transaction was aborted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AbortReason {
    /// The hard prepare budget (`T_prepare`, 90 s default) expired while
    /// `Draining`, `Fenced`, or `Snapshotted`.
    PrepareDeadlineExceeded,
    /// The durable marker `expires_at` passed while `Prepared` (default
    /// 45 s): the coordinator must move to `Aborted`, never restore the stale snapshot.
    PreparedExpired,
    /// The stop driver's abandon: a worker missed its graceful-stop
    /// budget (spec §5 `Stopping` -> `Aborted`); sessions were never killed.
    UpdateAbandoned,
}

impl AbortReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AbortReason::PrepareDeadlineExceeded => "prepare_deadline_exceeded",
            AbortReason::PreparedExpired => "prepared_expired",
            AbortReason::UpdateAbandoned => "update_abandoned",
        }
    }
}

/// The outcome of an abort: the aborted update plus whether its prepared
/// artifacts need deletion on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AbortOutcome {
    pub(crate) update_id: UpdateId,
    pub(crate) delete_prepared: bool,
    pub(crate) reason: AbortReason,
}

/// The prepare transaction of one `update_id`: all transitions are legality-checked (a driver bug
/// surfaces as an error, never a silent state jump).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrepareTransaction {
    update_id: UpdateId,
    state: PrepareState,
    accepted_at_ms: u64,
    /// Hard deadline for `Draining..Snapshotted` (epoch ms).
    prepare_deadline_ms: u64,
    /// Durable marker expiry armed at `Snapshotted` (epoch ms).
    marker_expires_at_ms: Option<u64>,
}

impl PrepareTransaction {
    fn begin(update_id: UpdateId, now_ms: u64, budget: &UpdateTimeoutBudget) -> Self {
        PrepareTransaction {
            update_id,
            state: PrepareState::Draining,
            accepted_at_ms: now_ms,
            prepare_deadline_ms: now_ms + budget.prepare_ms,
            marker_expires_at_ms: None,
        }
    }

    /// The watchdog budget of the current state (spec §5 exit events): the
    /// epoch-ms instant it expires and the abort it causes. `Stopping` has
    /// no watchdog here: its budget is the per-worker stop budget, owned by
    /// the graceful-stop protocol.
    fn watchdog(&self) -> Option<(u64, AbortReason)> {
        match self.state {
            PrepareState::Draining | PrepareState::Fenced | PrepareState::Snapshotted => Some((
                self.prepare_deadline_ms,
                AbortReason::PrepareDeadlineExceeded,
            )),
            PrepareState::Prepared => self
                .marker_expires_at_ms
                .map(|expires_at_ms| (expires_at_ms, AbortReason::PreparedExpired)),
            PrepareState::Stopping => None,
        }
    }

    /// `Draining -> Fenced`: the mutation drain completed.
    fn drain_complete(&mut self) -> Result<PrepareState> {
        self.transition(PrepareState::Fenced, "drain_complete")
    }

    /// `Fenced -> Snapshotted`: roster + marker written durably; the caller
    /// writes the artifacts (with [`marker_expiry_ms`]) before this call.
    fn snapshot_written(
        &mut self,
        now_ms: u64,
        budget: &UpdateTimeoutBudget,
    ) -> Result<PrepareState> {
        self.marker_expires_at_ms = Some(marker_expiry_ms(now_ms, budget));
        self.transition(PrepareState::Snapshotted, "snapshot_written")
    }

    /// `Snapshotted -> Prepared`: the coordinator was acked.
    fn prepare_acked(&mut self) -> Result<PrepareState> {
        self.transition(PrepareState::Prepared, "prepare_acked")
    }

    /// `Prepared -> Stopping`: the coordinator consumed the roster (the only
    /// consumption of the prepared artifact).
    fn commit(&mut self) -> Result<PrepareState> {
        self.transition(PrepareState::Stopping, "commit")
    }

    fn transition(&mut self, to: PrepareState, op: &'static str) -> Result<PrepareState> {
        let legal = matches!(
            (self.state, to),
            (PrepareState::Draining, PrepareState::Fenced)
                | (PrepareState::Fenced, PrepareState::Snapshotted)
                | (PrepareState::Snapshotted, PrepareState::Prepared)
                | (PrepareState::Prepared, PrepareState::Stopping)
        );
        if !legal {
            bail!(
                "illegal prepare transition {op}: {} -> {}",
                self.state.wire_name(),
                to.wire_name()
            );
        }
        self.state = to;
        Ok(to)
    }

    fn update_id(&self) -> &UpdateId {
        &self.update_id
    }

    fn state(&self) -> PrepareState {
        self.state
    }

    fn accepted_at_ms(&self) -> u64 {
        self.accepted_at_ms
    }
}

/// The marker's `expires_at` (epoch ms) for a snapshot taken at `now_ms`.
/// One definition shared by the artifact writer and the state transition.
pub(crate) fn marker_expiry_ms(now_ms: u64, budget: &UpdateTimeoutBudget) -> u64 {
    now_ms + budget.prepared_expiry_ms
}

/// ISO timestamp of a marker expiry (the string written into `marker.json`).
pub(crate) fn marker_expires_at_iso(now_ms: u64, budget: &UpdateTimeoutBudget) -> String {
    iso_from_unix_ms(marker_expiry_ms(now_ms, budget))
}

/// The coordinator-facing transaction manager: at most one active
/// transaction per supervisor; `Serving` is the empty state.
#[derive(Debug, Default)]
pub(crate) struct PrepareCoordinator {
    inner: Mutex<Option<PrepareTransaction>>,
    /// Woken whenever a transition moves the watchdog budget.
    watchdog_moved: tokio::sync::Notify,
}

/// Result of [`PrepareCoordinator::begin`].
pub(crate) enum BeginOutcome {
    /// A new transaction started in `Draining`.
    Started {
        accepted_at_ms: u64,
        prepare_deadline_ms: u64,
    },
    /// A repeated request for the same `update_id`: the current state, with
    /// the original budget (a poll never extends the deadline).
    AlreadyActive {
        state: PrepareState,
        accepted_at_ms: u64,
    },
    /// A different `update_id` while a transaction is active: a typed
    /// refusal the coordinator maps to `Join`.
    Refused { active_update_id: UpdateId },
}

/// Result of a driver operation against the active transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrepareOp {
    /// Applied; carries the new state.
    Applied(PrepareState),
    /// No matching transaction: it aborted (watchdog) or never existed.
    NotActive,
}

impl PrepareCoordinator {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Run one operation on the transaction slot, waking the expiry wait
    /// when the operation moved the watchdog budget.
    fn modify<R>(&self, operation: impl FnOnce(&mut Option<PrepareTransaction>) -> R) -> R {
        let mut inner = self.inner.lock().unwrap();
        let before = inner.as_ref().and_then(PrepareTransaction::watchdog);
        let output = operation(&mut inner);
        if inner.as_ref().and_then(PrepareTransaction::watchdog) != before {
            self.watchdog_moved.notify_one();
        }
        output
    }

    /// Accept a prepare request (idempotent on `update_id`, refusing any
    /// other id while active).
    pub(crate) fn begin(
        &self,
        update_id: UpdateId,
        now_ms: u64,
        budget: &UpdateTimeoutBudget,
    ) -> BeginOutcome {
        self.modify(|inner| match inner.as_ref() {
            Some(active) if *active.update_id() == update_id => BeginOutcome::AlreadyActive {
                state: active.state(),
                accepted_at_ms: active.accepted_at_ms(),
            },
            Some(active) => BeginOutcome::Refused {
                active_update_id: active.update_id().clone(),
            },
            None => {
                let transaction = PrepareTransaction::begin(update_id, now_ms, budget);
                let outcome = BeginOutcome::Started {
                    accepted_at_ms: transaction.accepted_at_ms(),
                    prepare_deadline_ms: transaction.prepare_deadline_ms,
                };
                *inner = Some(transaction);
                outcome
            }
        })
    }

    /// Watchdog poll: abort an active transaction whose budget expired.
    /// Called when the expiry wait fires and on any later command (spec §5).
    pub(crate) fn abort_if_expired(&self, now_ms: u64) -> Option<AbortOutcome> {
        self.modify(|inner| {
            let (deadline_ms, reason) = inner.as_ref()?.watchdog()?;
            if now_ms < deadline_ms {
                return None;
            }
            take_locked(inner, reason)
        })
    }

    /// Driver abort (failure default - rollback over retry). Idempotent:
    /// a second abort for the same id finds nothing and returns `None`.
    pub(crate) fn abort(&self, update_id: &UpdateId) -> Option<AbortOutcome> {
        self.modify(|inner| match inner.as_ref() {
            Some(active) if *active.update_id() == *update_id => {
                // The stop protocol owns `Stopping` from here on; the driver
                // aborts only its own prepare phases.
                if active.state() == PrepareState::Stopping {
                    return None;
                }
                take_locked(inner, AbortReason::PrepareDeadlineExceeded)
            }
            _ => None,
        })
    }

    /// `Draining -> Fenced` for the named transaction.
    pub(crate) fn drain_complete(&self, update_id: &UpdateId) -> PrepareOp {
        self.apply(update_id, PrepareTransaction::drain_complete)
    }

    /// `Fenced -> Snapshotted` for the named transaction; the caller wrote the artifacts first.
    pub(crate) fn snapshot_written(
        &self,
        update_id: &UpdateId,
        now_ms: u64,
        budget: &UpdateTimeoutBudget,
    ) -> PrepareOp {
        self.apply(update_id, |transaction| {
            transaction.snapshot_written(now_ms, budget)
        })
    }

    /// `Snapshotted -> Prepared` for the named transaction.
    pub(crate) fn prepare_acked(&self, update_id: &UpdateId) -> PrepareOp {
        self.apply(update_id, PrepareTransaction::prepare_acked)
    }

    /// `Prepared -> Stopping` for the named transaction; idempotent while
    /// already `Stopping` (the coordinator may poll the commit).
    pub(crate) fn commit(&self, update_id: &UpdateId) -> PrepareOp {
        self.modify(|inner| {
            let Some(transaction) = inner.as_mut() else {
                return PrepareOp::NotActive;
            };
            if *transaction.update_id() != *update_id {
                return PrepareOp::NotActive;
            }
            if transaction.state() == PrepareState::Stopping {
                return PrepareOp::Applied(PrepareState::Stopping);
            }
            match transaction.commit() {
                Ok(state) => PrepareOp::Applied(state),
                Err(_) => PrepareOp::NotActive,
            }
        })
    }

    /// `Stopping -> Aborted` (spec §5's `worker budget exceeded -> Aborted`): only the stop driver
    /// may take the transaction; the prepared artifacts are garbage and must be deleted.
    pub(crate) fn abandon_stopping(&self, update_id: &UpdateId) -> Option<AbortOutcome> {
        self.modify(|inner| match inner.as_ref() {
            Some(transaction)
                if *transaction.update_id() == *update_id
                    && transaction.state() == PrepareState::Stopping =>
            {
                take_locked(inner, AbortReason::UpdateAbandoned)
            }
            _ => None,
        })
    }

    fn apply(
        &self,
        update_id: &UpdateId,
        operation: impl FnOnce(&mut PrepareTransaction) -> Result<PrepareState>,
    ) -> PrepareOp {
        self.modify(|inner| {
            let Some(transaction) = inner.as_mut() else {
                return PrepareOp::NotActive;
            };
            if *transaction.update_id() != *update_id {
                return PrepareOp::NotActive;
            }
            match operation(transaction) {
                Ok(state) => PrepareOp::Applied(state),
                Err(_) => PrepareOp::NotActive,
            }
        })
    }

    /// Wait until the active transaction's watchdog budget expires, abort
    /// it, and return the abort (spec §5 invariant I1: every state has a
    /// watchdog exit). One waiter only (the supervisor's watchdog task):
    /// a transition that lands while no one is parked leaves a
    /// `notify_one` permit, which the next wait consumes.
    pub(crate) async fn wait_for_expiry(&self) -> AbortOutcome {
        loop {
            let moved = self.watchdog_moved.notified();
            let watchdog = self
                .inner
                .lock()
                .unwrap()
                .as_ref()
                .and_then(PrepareTransaction::watchdog);
            let Some((deadline_ms, _)) = watchdog else {
                moved.await;
                continue;
            };
            // The budget is wall-clock epoch ms (durable in marker.json).
            let remaining = Duration::from_millis(deadline_ms.saturating_sub(now_ms()));
            tokio::select! {
                () = moved => {}
                () = tokio::time::sleep(remaining) => {
                    if let Some(abort) = self.abort_if_expired(now_ms()) {
                        return abort;
                    }
                }
            }
        }
    }

    /// The state of the active transaction, if any.
    pub(crate) fn active_state(&self) -> Option<PrepareState> {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(PrepareTransaction::state)
    }

    /// The active transaction's update id, if any.
    /// Reader: coordinator slice (`#[allow(dead_code)]` until then).
    #[allow(dead_code)]
    pub(crate) fn active_update_id(&self) -> Option<UpdateId> {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| t.update_id().clone())
    }
}

fn take_locked(
    inner: &mut Option<PrepareTransaction>,
    reason: AbortReason,
) -> Option<AbortOutcome> {
    let transaction = inner.take()?;
    Some(AbortOutcome {
        delete_prepared: transaction.state().has_prepared_artifacts(),
        update_id: transaction.update_id().clone(),
        reason,
    })
}

/// TS message for a mutating command refused by the admission gate
/// (owned by `pa_types::daemon` for the TUI's exact-message fallback).
pub(crate) use pa_types::daemon::UPDATE_RESTART_PREPARING_MESSAGE as UPDATE_PREPARING_MESSAGE;

/// The admission gate verdict (spec §5): mutating commands are refused
/// while `Draining..Prepared`, except the abort-family drain commands,
/// which TS lets through during `Draining` (they shorten the drain).
pub(crate) fn update_gate_refuses(state: PrepareState, command_type: &str) -> bool {
    if !is_daemon_mutating_command(command_type) {
        return false;
    }
    !(state == PrepareState::Draining && is_update_drain_command(command_type))
}

/// The prepared directory for one update under the socket's scratch dir.
/// `socket_hash` is the sha256 hex of the normalized socket path.
pub(crate) fn prepared_dir(agent_dir: &Path, socket_hash: &str, update_id: &UpdateId) -> PathBuf {
    prepared_dir_of(&socket_update_dir(agent_dir, socket_hash), update_id)
}

/// Write `roster.json` + `marker.json` durably into the prepared dir (one atomic 0600 write per
/// file, fsync before rename); call this between `Fenced` and the `Snapshotted`, then ack.
pub(crate) fn write_prepared_artifacts(
    prepared_dir: &Path,
    roster: &UpdateRoster,
    marker: &UpdatePreparedMarker,
) -> Result<()> {
    std::fs::create_dir_all(prepared_dir)
        .with_context(|| format!("create {}", prepared_dir.display()))?;
    crate::descriptor::write_file_atomic(
        &prepared_dir.join("roster.json"),
        &serde_json::to_string_pretty(roster)?,
    )?;
    crate::descriptor::write_file_atomic(
        &prepared_dir.join("marker.json"),
        &serde_json::to_string_pretty(marker)?,
    )
}

/// Read the prepared marker back (expired markers are the coordinator's
/// refusal); `None` if absent or unparseable.
#[allow(dead_code)] // graceful-stop slice wires the writers; boot reads here
pub(crate) fn read_prepared_marker(prepared_dir: &Path) -> Option<UpdatePreparedMarker> {
    let content = std::fs::read_to_string(prepared_dir.join("marker.json")).ok()?;
    serde_json::from_str(&content).ok()
}

/// Delete the prepared dir; idempotent (the supervisor's self-expiry and the
/// coordinator's post-restore cleanup both run, and both must be safe).
pub(crate) fn delete_prepared_dir(prepared_dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(prepared_dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", prepared_dir.display())),
    }
}

/// Counts in-flight mutating commands so `Draining` can wait for them
/// (TS `MutationDrainLatch`): the wait is cancel-safe and race-free.
#[derive(Clone)]
pub(crate) struct MutationDrainLatch {
    active: watch::Sender<u64>,
}

impl MutationDrainLatch {
    pub(crate) fn new() -> Self {
        MutationDrainLatch {
            active: watch::Sender::new(0),
        }
    }

    pub(crate) fn begin(&self) {
        self.active.send_if_modified(|count| {
            *count += 1;
            true
        });
    }

    pub(crate) fn end(&self) {
        self.active.send_if_modified(|count| {
            *count = count.saturating_sub(1);
            true
        });
    }

    /// Wait until at most `remaining` mutations are in flight, or fail with
    /// the TS message when the deadline passes.
    pub(crate) async fn wait_for_drain(&self, remaining: u64, deadline: Instant) -> Result<()> {
        const ABORT_MESSAGE: &str = "Timed out draining daemon mutations for update restart";
        let mut receiver = self.active.subscribe();
        let drained = receiver.wait_for(|count| *count <= remaining);
        if tokio::time::timeout_at(deadline, drained).await.is_err() {
            // Re-check after the timeout: the last `end()` may have raced the
            // deadline.
            if *self.active.subscribe().borrow() <= remaining {
                return Ok(());
            }
            bail!("{ABORT_MESSAGE}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Wake, Waker};

    use super::*;
    use pa_types::daemon::{update_marker_path, update_roster_path, UpdateSupervisorIdentity};
    use serde_json::Map;

    fn budget() -> UpdateTimeoutBudget {
        // CI-scale budgets keep every test sub-second.
        UpdateTimeoutBudget {
            prepare_ms: 200,
            prepared_expiry_ms: 100,
            ..UpdateTimeoutBudget::default()
        }
    }

    fn id(name: &str) -> UpdateId {
        UpdateId::from(String::from(name))
    }

    #[test]
    fn begin_is_idempotent_and_refuses_other_ids() {
        let coordinator = PrepareCoordinator::new();
        let now = 1_000;
        let budget = budget();
        let BeginOutcome::Started {
            prepare_deadline_ms,
            ..
        } = coordinator.begin(id("u1"), now, &budget)
        else {
            panic!("first begin must start");
        };
        assert_eq!(prepare_deadline_ms, now + budget.prepare_ms);
        match coordinator.begin(id("u1"), now + 50, &budget) {
            BeginOutcome::AlreadyActive {
                state,
                accepted_at_ms,
            } => {
                assert_eq!(state, PrepareState::Draining);
                assert_eq!(accepted_at_ms, now);
            }
            _ => panic!("same-id begin must be idempotent"),
        }
        match coordinator.begin(id("u2"), now + 50, &budget) {
            BeginOutcome::Refused { active_update_id } => {
                assert_eq!(active_update_id, id("u1"));
            }
            _ => panic!("other-id begin must be refused"),
        }
    }

    #[test]
    fn transitions_walk_the_spec_path() {
        let coordinator = PrepareCoordinator::new();
        let budget = budget();
        coordinator.begin(id("u1"), 1_000, &budget);
        assert_eq!(
            coordinator.drain_complete(&id("u1")),
            PrepareOp::Applied(PrepareState::Fenced)
        );
        assert_eq!(
            coordinator.snapshot_written(&id("u1"), 1_050, &budget),
            PrepareOp::Applied(PrepareState::Snapshotted)
        );
        assert_eq!(
            coordinator.prepare_acked(&id("u1")),
            PrepareOp::Applied(PrepareState::Prepared)
        );
        assert_eq!(
            coordinator.commit(&id("u1")),
            PrepareOp::Applied(PrepareState::Stopping)
        );
        // The stop budget is owned by the graceful-stop slice; no further op applies.
        assert_eq!(coordinator.drain_complete(&id("u1")), PrepareOp::NotActive);
    }

    #[test]
    fn illegal_transitions_and_wrong_ids_do_not_apply() {
        let coordinator = PrepareCoordinator::new();
        let budget = budget();
        coordinator.begin(id("u1"), 1_000, &budget);
        // Snapshot before drain is an illegal transition (driver bug), not a silent jump.
        assert_eq!(
            coordinator.snapshot_written(&id("u1"), 1_000, &budget),
            PrepareOp::NotActive
        );
        assert_eq!(coordinator.active_state(), Some(PrepareState::Draining));
        assert_eq!(
            coordinator.drain_complete(&id("other")),
            PrepareOp::NotActive
        );
        assert_eq!(coordinator.active_state(), Some(PrepareState::Draining));
    }

    #[test]
    fn prepare_deadline_watchdog_aborts_back_to_serving() {
        let coordinator = PrepareCoordinator::new();
        let budget = budget();
        let now = 1_000;
        coordinator.begin(id("u1"), now, &budget);
        assert_eq!(
            coordinator.abort_if_expired(now + budget.prepare_ms - 1),
            None
        );
        assert_eq!(coordinator.active_state(), Some(PrepareState::Draining));
        let abort = coordinator
            .abort_if_expired(now + budget.prepare_ms)
            .expect("deadline abort");
        assert_eq!(abort.update_id, id("u1"));
        assert_eq!(abort.reason, AbortReason::PrepareDeadlineExceeded);
        assert!(!abort.delete_prepared);
        assert!(matches!(
            coordinator.begin(id("u1"), now + budget.prepare_ms + 1, &budget),
            BeginOutcome::Started { .. }
        ));
        assert_eq!(coordinator.active_state(), Some(PrepareState::Draining));
    }

    #[test]
    fn commit_is_idempotent_while_stopping_and_abandon_takes_it() {
        let coordinator = PrepareCoordinator::new();
        let budget = budget();
        coordinator.begin(id("u1"), 1_000, &budget);
        assert_eq!(
            coordinator.drain_complete(&id("u1")),
            PrepareOp::Applied(PrepareState::Fenced)
        );
        assert_eq!(
            coordinator.snapshot_written(&id("u1"), 1_050, &budget),
            PrepareOp::Applied(PrepareState::Snapshotted)
        );
        assert_eq!(
            coordinator.prepare_acked(&id("u1")),
            PrepareOp::Applied(PrepareState::Prepared)
        );
        assert_eq!(
            coordinator.commit(&id("u1")),
            PrepareOp::Applied(PrepareState::Stopping)
        );
        assert_eq!(
            coordinator.commit(&id("u1")),
            PrepareOp::Applied(PrepareState::Stopping)
        );
        // The stop driver's abandon takes Stopping (and only Stopping).
        let abort = coordinator
            .abandon_stopping(&id("u1"))
            .expect("abandon takes Stopping");
        assert_eq!(abort.update_id, id("u1"));
        assert_eq!(abort.reason, AbortReason::UpdateAbandoned);
        assert!(abort.delete_prepared);
        assert_eq!(coordinator.active_state(), None);
        assert!(coordinator.abandon_stopping(&id("u1")).is_none());
        // A Prepared (not Stopping) transaction is not abandonable by this op.
        coordinator.begin(id("u2"), 2_000, &budget);
        assert_eq!(
            coordinator.drain_complete(&id("u2")),
            PrepareOp::Applied(PrepareState::Fenced)
        );
        assert_eq!(
            coordinator.snapshot_written(&id("u2"), 2_050, &budget),
            PrepareOp::Applied(PrepareState::Snapshotted)
        );
        assert_eq!(
            coordinator.prepare_acked(&id("u2")),
            PrepareOp::Applied(PrepareState::Prepared)
        );
        assert!(coordinator.abandon_stopping(&id("u2")).is_none());
    }

    #[test]
    fn prepared_self_expiry_survives_coordinator_death() {
        // Spec §5/I1: a coordinator dying after the ack leaves at worst a
        // Prepared transaction; the durable marker expires it.
        let coordinator = PrepareCoordinator::new();
        let budget = budget();
        let now = 1_000;
        coordinator.begin(id("u1"), now, &budget);
        assert_eq!(
            coordinator.drain_complete(&id("u1")),
            PrepareOp::Applied(PrepareState::Fenced)
        );
        let snapshot_at = now + 10;
        assert_eq!(
            coordinator.snapshot_written(&id("u1"), snapshot_at, &budget),
            PrepareOp::Applied(PrepareState::Snapshotted)
        );
        assert_eq!(
            coordinator.prepare_acked(&id("u1")),
            PrepareOp::Applied(PrepareState::Prepared)
        );
        assert_eq!(
            coordinator.abort_if_expired(snapshot_at + budget.prepared_expiry_ms - 1),
            None
        );
        let abort = coordinator
            .abort_if_expired(snapshot_at + budget.prepared_expiry_ms)
            .expect("marker expiry abort");
        assert_eq!(abort.reason, AbortReason::PreparedExpired);
        assert!(abort.delete_prepared);
        assert_eq!(coordinator.active_state(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_wait_parks_without_timers_and_rearms_when_the_budget_moves() {
        struct WakeCount(AtomicUsize);
        impl Wake for WakeCount {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let tally = Arc::new(WakeCount(AtomicUsize::new(0)));
        let woken = || tally.0.load(Ordering::SeqCst);
        let waker = Waker::from(Arc::clone(&tally));
        let mut cx = Context::from_waker(&waker);
        let coordinator = PrepareCoordinator::new();
        let mut wait = pin!(coordinator.wait_for_expiry());
        // The 1 h prepare deadline stays in the future; the marker expiry (1_100) is past.
        let budget = UpdateTimeoutBudget {
            prepare_ms: 3_600_000,
            prepared_expiry_ms: 100,
            ..UpdateTimeoutBudget::default()
        };

        // Idle parks with zero wakes: a day of paused time is silent.
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        tokio::time::advance(Duration::from_hours(24)).await;
        assert_eq!(woken(), 0);

        // Armed on the prepare deadline: silent for 600 s (an in-flight 1 Hz loop would wake here).
        coordinator.begin(id("u1"), now_ms(), &budget);
        assert_eq!(woken(), 1);
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        tokio::time::advance(Duration::from_secs(600)).await;
        assert_eq!(woken(), 1);

        // Only a budget move wakes: the ack swaps the deadline for the marker expiry.
        coordinator.drain_complete(&id("u1"));
        coordinator.snapshot_written(&id("u1"), 1_000, &budget);
        coordinator.prepare_acked(&id("u1"));
        assert_eq!(woken(), 2);
        let armed = Instant::now();
        assert_eq!(
            wait.as_mut().await,
            AbortOutcome {
                update_id: id("u1"),
                delete_prepared: true,
                reason: AbortReason::PreparedExpired,
            }
        );
        // Not after the dropped 1 h deadline (the wheel may tick 1 ms for a zero sleep).
        assert!(armed.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn abort_is_idempotent_and_owns_only_prepare_phases() {
        let coordinator = PrepareCoordinator::new();
        let budget = budget();
        coordinator.begin(id("u1"), 1_000, &budget);
        assert_eq!(
            coordinator.drain_complete(&id("u1")),
            PrepareOp::Applied(PrepareState::Fenced)
        );
        assert!(coordinator.abort(&id("u1")).is_some());
        assert!(coordinator.abort(&id("u1")).is_none());
        // Once committed (Stopping), the driver can no longer abort it.
        coordinator.begin(id("u2"), 2_000, &budget);
        assert_eq!(
            coordinator.drain_complete(&id("u2")),
            PrepareOp::Applied(PrepareState::Fenced)
        );
        assert_eq!(
            coordinator.snapshot_written(&id("u2"), 2_050, &budget),
            PrepareOp::Applied(PrepareState::Snapshotted)
        );
        assert_eq!(
            coordinator.prepare_acked(&id("u2")),
            PrepareOp::Applied(PrepareState::Prepared)
        );
        assert_eq!(
            coordinator.commit(&id("u2")),
            PrepareOp::Applied(PrepareState::Stopping)
        );
        assert!(coordinator.abort(&id("u2")).is_none());
        assert_eq!(coordinator.active_state(), Some(PrepareState::Stopping));
    }

    #[test]
    fn admission_gate_matches_the_ts_contract() {
        // Reads and attach always pass, whatever the state.
        for read_only in [
            "list",
            "attach",
            "get_state",
            "get_messages",
            "wait_for_idle",
        ] {
            assert!(!update_gate_refuses(PrepareState::Prepared, read_only));
        }
        // Mutations are refused in every active state.
        for mutating in ["prompt", "create", "kill", "shutdown", "set_model"] {
            for state in [
                PrepareState::Draining,
                PrepareState::Fenced,
                PrepareState::Snapshotted,
                PrepareState::Prepared,
            ] {
                assert!(update_gate_refuses(state, mutating), "{state:?} {mutating}");
            }
        }
        // The TS drain commands pass during Draining and only then.
        for drain in [
            "abort",
            "abort_bash",
            "abort_branch_summary",
            "abort_compaction",
            "abort_retry",
        ] {
            assert!(
                !update_gate_refuses(PrepareState::Draining, drain),
                "{drain}"
            );
            assert!(update_gate_refuses(PrepareState::Fenced, drain), "{drain}");
        }
    }

    #[test]
    fn marker_expiry_helpers_agree_with_pa_types_verdict() {
        let budget = budget();
        let now = 1_000;
        assert_eq!(
            marker_expiry_ms(now, &budget),
            now + budget.prepared_expiry_ms
        );
        assert_eq!(
            marker_expires_at_iso(now, &budget),
            iso_from_unix_ms(now + budget.prepared_expiry_ms)
        );
        // The written marker's expires_at must make the pa-types verdict flip
        // exactly at the same instant.
        let expires_at = marker_expires_at_iso(now, &budget);
        assert_eq!(
            pa_types::daemon::prepared_marker_expiry(
                &expires_at,
                &iso_from_unix_ms(now + budget.prepared_expiry_ms - 1)
            ),
            pa_types::daemon::PreparedMarkerExpiry::Active
        );
        assert_eq!(
            pa_types::daemon::prepared_marker_expiry(
                &expires_at,
                &iso_from_unix_ms(now + budget.prepared_expiry_ms)
            ),
            pa_types::daemon::PreparedMarkerExpiry::Expired
        );
    }

    #[test]
    fn prepared_artifact_lifecycle_is_durable_and_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let prepared = dir.path().join("prepared").join("u1");
        let budget = budget();
        let now = 1_000;
        let marker = UpdatePreparedMarker {
            update_id: id("u1"),
            expires_at: marker_expires_at_iso(now, &budget),
            supervisor: UpdateSupervisorIdentity {
                pid: 42,
                process_start_id: Some(String::from("42/7")),
                generation: String::from("gen-1"),
            },
            rest: Map::default(),
        };
        let roster = UpdateRoster {
            format_version: pa_types::daemon::UPDATE_ROSTER_FORMAT_VERSION,
            update_id: id("u1"),
            socket_path: String::from("/sock"),
            created_at: iso_from_unix_ms(now),
            supervisor: marker.supervisor.clone(),
            binary: pa_types::daemon::UpdateRosterBinary {
                from_version: String::from("0.1.0"),
                to_version: String::from("0.2.0"),
            },
            sessions: Vec::new(),
            workers: Vec::new(),
            subagents: Vec::new(),
            heartbeats: Vec::new(),
            rest: Map::default(),
        };
        write_prepared_artifacts(&prepared, &roster, &marker).expect("write artifacts");
        assert!(update_roster_path(&prepared).is_file());
        assert!(update_marker_path(&prepared).is_file());
        assert_eq!(read_prepared_marker(&prepared).as_ref(), Some(&marker));
        // Deleting twice is fine (self-expiry + coordinator cleanup).
        delete_prepared_dir(&prepared).expect("delete once");
        delete_prepared_dir(&prepared).expect("delete twice");
        assert_eq!(read_prepared_marker(&prepared), None);
    }

    #[tokio::test(start_paused = true)]
    async fn mutation_drain_latch_waits_and_times_out() {
        let latch = MutationDrainLatch::new();
        latch.begin();
        latch.begin();
        latch.end();
        // One mutation still in flight: the wait parks until it ends.
        let waiter = {
            let latch = latch.clone();
            tokio::spawn(async move {
                latch
                    .wait_for_drain(0, Instant::now() + Duration::from_secs(10))
                    .await
            })
        };
        tokio::time::advance(Duration::from_millis(1)).await;
        latch.end();
        waiter.await.unwrap().expect("drains after end");
        // Deadline path: a stuck mutation times out with the TS message.
        latch.begin();
        let deadline = Instant::now() + Duration::from_secs(5);
        let error = latch
            .wait_for_drain(0, deadline)
            .await
            .expect_err("must time out");
        assert_eq!(
            error.to_string(),
            "Timed out draining daemon mutations for update restart"
        );
    }
}
