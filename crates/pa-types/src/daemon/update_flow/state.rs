//! The coordinator FSM states and the legal transition table.
//!
//! The update coordinator drives the states of spec §4. Every state is written
//! to the status file before acting, so the transition table here is the
//! single legality reference shared by the coordinator driver (pa-cli), the
//! status tailing of a joined coordinator, and the tests of the watchdog
//! paths (spec §9): a state may only move to one of its successors, and the
//! terminal set (`Complete`, `Join`, `Skipped`, `Aborted`, `Failed`) accepts
//! no further transitions.

use serde::{Deserialize, Serialize};

/// One state of the update coordinator FSM (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateState {
    /// Coordinator start: contending for the per-socket intent lock.
    Acquire,
    /// Another live coordinator holds the intent lock; this process relays its status.
    Join,
    /// Lock acquired; deciding between update candidate, rollback, or skip.
    Planning,
    /// Downloading and checksum-validating the release candidate.
    Downloading,
    /// Candidate extracted and validated on disk.
    Staged,
    /// `prepare_update_restart` sent; waiting for the old supervisor's ack.
    Preparing,
    /// Old supervisor acked the prepare transaction (roster durable).
    Prepared,
    /// Coordinator consumed the roster; workers are stopping gracefully.
    Stopping,
    /// All workers flushed and exited; the old supervisor is leaving.
    Stopped,
    /// Launcher symlink swap plus validation probes.
    Activating,
    /// New (or rollback) supervisor spawned; waiting for the boot hello.
    Booting,
    /// New supervisor is up; restoring sessions from the roster.
    Restoring,
    /// Boot or activation failed; the previous binary takes over (still a
    /// first-class serving end state, not an error).
    Rollback,
    /// Terminal: updated and restored.
    Complete,
    /// Terminal: no update candidate.
    Skipped,
    /// Terminal: daemon never stopped; user may retry later.
    Aborted,
    /// Terminal: supervisor down; sessions persist on disk for manual attach.
    Failed,
}

impl UpdateState {
    /// The states this one may legally move to (spec §4 transition table).
    pub fn successors(self) -> &'static [UpdateState] {
        match self {
            Self::Acquire => &[UpdateState::Join, UpdateState::Planning],
            Self::Join => &[],
            Self::Planning => &[
                UpdateState::Downloading,
                UpdateState::Skipped,
                UpdateState::Rollback,
            ],
            Self::Downloading => &[UpdateState::Staged, UpdateState::Aborted],
            Self::Staged => &[UpdateState::Preparing, UpdateState::Aborted],
            Self::Preparing => &[UpdateState::Prepared, UpdateState::Aborted],
            Self::Prepared => &[UpdateState::Stopping, UpdateState::Aborted],
            Self::Stopping => &[UpdateState::Stopped, UpdateState::Aborted],
            Self::Stopped => &[UpdateState::Activating, UpdateState::Rollback],
            Self::Activating => &[UpdateState::Booting, UpdateState::Rollback],
            Self::Booting => &[UpdateState::Restoring, UpdateState::Rollback],
            Self::Restoring => &[UpdateState::Complete],
            Self::Rollback => &[UpdateState::Booting, UpdateState::Failed],
            Self::Complete => &[],
            Self::Skipped => &[],
            Self::Aborted => &[],
            Self::Failed => &[],
        }
    }

    /// Terminal states relay a final status and never transition again.
    pub fn is_terminal(self) -> bool {
        self.successors().is_empty()
    }
}

/// Whether the coordinator FSM may move `from` to `to` (spec §4). Every
/// out-of-table move is a driver bug: the watchdog table (spec §9) only ever
/// produces the successors listed here.
pub fn update_transition_allowed(from: UpdateState, to: UpdateState) -> bool {
    from.successors().contains(&to)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The spec §4 state diagram, spelled out as an explicit adjacency list:
    /// every listed edge must be legal and every other pair must not be.
    const SPEC_EDGES: &[(UpdateState, UpdateState)] = &[
        (UpdateState::Acquire, UpdateState::Join),
        (UpdateState::Acquire, UpdateState::Planning),
        (UpdateState::Planning, UpdateState::Downloading),
        (UpdateState::Planning, UpdateState::Skipped),
        (UpdateState::Planning, UpdateState::Rollback),
        (UpdateState::Downloading, UpdateState::Staged),
        (UpdateState::Downloading, UpdateState::Aborted),
        (UpdateState::Staged, UpdateState::Preparing),
        (UpdateState::Staged, UpdateState::Aborted),
        (UpdateState::Preparing, UpdateState::Prepared),
        (UpdateState::Preparing, UpdateState::Aborted),
        (UpdateState::Prepared, UpdateState::Stopping),
        (UpdateState::Prepared, UpdateState::Aborted),
        (UpdateState::Stopping, UpdateState::Stopped),
        (UpdateState::Stopping, UpdateState::Aborted),
        (UpdateState::Stopped, UpdateState::Activating),
        (UpdateState::Stopped, UpdateState::Rollback),
        (UpdateState::Activating, UpdateState::Booting),
        (UpdateState::Activating, UpdateState::Rollback),
        (UpdateState::Booting, UpdateState::Restoring),
        (UpdateState::Booting, UpdateState::Rollback),
        (UpdateState::Rollback, UpdateState::Booting),
        (UpdateState::Rollback, UpdateState::Failed),
        (UpdateState::Restoring, UpdateState::Complete),
    ];

    const ALL: &[UpdateState] = &[
        UpdateState::Acquire,
        UpdateState::Join,
        UpdateState::Planning,
        UpdateState::Downloading,
        UpdateState::Staged,
        UpdateState::Preparing,
        UpdateState::Prepared,
        UpdateState::Stopping,
        UpdateState::Stopped,
        UpdateState::Activating,
        UpdateState::Booting,
        UpdateState::Restoring,
        UpdateState::Rollback,
        UpdateState::Complete,
        UpdateState::Skipped,
        UpdateState::Aborted,
        UpdateState::Failed,
    ];

    #[test]
    fn transition_table_matches_spec_exactly() {
        for from in ALL {
            for to in ALL {
                let allowed = update_transition_allowed(*from, *to);
                let expected = SPEC_EDGES.contains(&(*from, *to));
                assert_eq!(
                    allowed, expected,
                    "transition {from:?} -> {to:?}: allowed={allowed}, spec={expected}"
                );
            }
        }
    }

    #[test]
    fn terminal_set_is_join_complete_skipped_aborted_failed() {
        for state in ALL {
            assert_eq!(
                state.is_terminal(),
                matches!(
                    state,
                    UpdateState::Complete
                        | UpdateState::Join
                        | UpdateState::Skipped
                        | UpdateState::Aborted
                        | UpdateState::Failed
                ),
                "terminal classification of {state:?}"
            );
        }
    }

    #[test]
    fn every_state_has_an_outgoing_or_terminal_role() {
        // Every non-terminal state must have at least one successor; terminal
        // states have none. This pins the table against an accidentally
        // wedged state (invariant I1: no state without a watchdog exit).
        for state in ALL {
            if state.is_terminal() {
                assert!(state.successors().is_empty());
            } else {
                assert!(
                    !state.successors().is_empty(),
                    "non-terminal state {state:?} has no legal successor"
                );
            }
        }
    }

    #[test]
    fn state_wire_names_are_lowercase() {
        use UpdateState as S;
        assert_eq!(serde_json::to_value(S::Acquire).unwrap(), "acquire");
        assert_eq!(serde_json::to_value(S::Rollback).unwrap(), "rollback");
        assert_eq!(serde_json::to_value(S::Complete).unwrap(), "complete");
        assert_eq!(serde_json::to_value(S::Aborted).unwrap(), "aborted");
        let parsed: UpdateState = serde_json::from_value("restoring".into()).unwrap();
        assert_eq!(parsed, S::Restoring);
    }
}
