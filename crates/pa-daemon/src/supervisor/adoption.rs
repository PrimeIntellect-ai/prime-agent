//! Worker adoption: the boot discovery pass and the per-worker
//! adoption outcomes.

/// The boot the descriptor-adoption pass runs under. An update boot
/// relaunches kept workers from their descriptors before the roster
/// restore walks the rows (spec §6 step 2's create-or-adopt order). A
/// plain startup adopts live workers and revives only genuinely
/// interrupted ones: a supervisor restart must not mass-revive the
/// historical idle/completed sessions a TS daemon leaves down (their
/// clients reopen them lazily through a fresh create).
#[derive(Clone, PartialEq, Eq)]
pub(super) enum AdoptionBoot {
    /// Update boot: the roster's kept workers (by worker id) relaunch
    /// eagerly ahead of the restore pass; busy-at-crash workers revive
    /// too. Descriptors the update does not keep stay down — the update
    /// must not revive the sessions a plain boot parked (a reopened
    /// session file may already have a newer worker). The kept set is
    /// shared (an `Arc`): one clone per descriptor task, not a deep
    /// copy of every kept id per task.
    UpdateRoster {
        kept: Arc<std::collections::HashSet<String>>,
    },
    /// Plain startup: only journal-proven live work revives.
    PlainStartup,
}

/// One descriptor's boot-adoption decision, reported as a count in the
/// pass's `worker_adoption` event (telemetry: counts only, never session
/// payload).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AdoptionOutcome {
    /// Live socket adopted (incl. a worker that re-registered before the
    /// descriptor scan reached it).
    AdoptedLive,
    /// Dead descriptor relaunched (busy evidence on a plain boot, kept
    /// worker on an update boot).
    Revived,
    /// Dead descriptor with no durable busy evidence: stayed down.
    SkippedIdle,
    /// The descriptor carried a durable stop tombstone: the boot re-ran
    /// the stop's finalization instead of adopting or reviving.
    Stopped,
    /// Adoption or relaunch failed.
    Failed,
}
