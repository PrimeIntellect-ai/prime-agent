//! Quiescence: when one state entry settles, and when a run has no work
//! left.
//!
//! An entry settles only when two conditions are true: every child that
//! the entry admitted settled, and the executor committed the entry's
//! result (the outputs, or the failure). Nothing in this module reads a
//! clock. A timer cannot settle an entry. A child that runs too long
//! settles through its cancellation, and the executor then commits the
//! failure.

use std::collections::BTreeMap;
use std::fmt;

/// The result that the executor commits for one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryResult {
    /// The outputs are written and checked against the state's contract.
    Outputs,
    /// The entry failed. The state's failure policy applies.
    Failed,
}

/// The phase of one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryPhase {
    /// One or more admitted children did not settle.
    Running,
    /// No child is in flight. The entry waits for its committed result.
    AwaitingCommit,
    /// The entry settled with this result.
    Settled(EntryResult),
}

/// One input to an entry's settlement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleEvent {
    /// The executor started this child for the entry.
    Admit(String),
    /// This child settled.
    ChildSettled(String),
    /// The executor committed the entry's result.
    Commit(EntryResult),
}

/// An event that the entry's phase does not accept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IllegalSettle {
    pub phase: EntryPhase,
    pub event: SettleEvent,
}

impl fmt::Display for IllegalSettle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "illegal settle: {:?} while the entry is {:?}",
            self.event, self.phase
        )
    }
}

impl std::error::Error for IllegalSettle {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildProgress {
    Running,
    Settled,
}

/// The settlement record of one state entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntrySettlement {
    children: BTreeMap<String, ChildProgress>,
    result: Option<EntryResult>,
}

impl EntrySettlement {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn phase(&self) -> EntryPhase {
        match self.result {
            Some(result) => EntryPhase::Settled(result),
            None if self
                .children
                .values()
                .any(|&progress| progress == ChildProgress::Running) =>
            {
                EntryPhase::Running
            }
            None => EntryPhase::AwaitingCommit,
        }
    }

    /// Apply one event and return the new phase.
    ///
    /// # Errors
    ///
    /// Returns an [`IllegalSettle`] and changes nothing when:
    /// - the entry settled before,
    /// - the admitted child is admitted already,
    /// - the settled child is not admitted or settled before,
    /// - a commit occurs while a child is in flight.
    pub fn apply(&mut self, event: SettleEvent) -> Result<EntryPhase, IllegalSettle> {
        let phase = self.phase();
        let accepted = match (&event, phase) {
            (_, EntryPhase::Settled(_)) | (SettleEvent::Commit(_), EntryPhase::Running) => false,
            (SettleEvent::Admit(child), EntryPhase::Running | EntryPhase::AwaitingCommit) => {
                !self.children.contains_key(child)
            }
            (
                SettleEvent::ChildSettled(child),
                EntryPhase::Running | EntryPhase::AwaitingCommit,
            ) => self.children.get(child) == Some(&ChildProgress::Running),
            (SettleEvent::Commit(_), EntryPhase::AwaitingCommit) => true,
        };
        if !accepted {
            return Err(IllegalSettle { phase, event });
        }
        match event {
            SettleEvent::Admit(child) => {
                self.children.insert(child, ChildProgress::Running);
            }
            SettleEvent::ChildSettled(child) => {
                self.children.insert(child, ChildProgress::Settled);
            }
            SettleEvent::Commit(result) => self.result = Some(result),
        }
        Ok(self.phase())
    }
}

/// True when the run has no work left: no settle waits for its
/// transitions to be evaluated, and every entry settled.
pub fn run_quiescent<'a>(
    pending_evaluations: usize,
    entries: impl IntoIterator<Item = &'a EntrySettlement>,
) -> bool {
    pending_evaluations == 0
        && entries
            .into_iter()
            .all(|entry| matches!(entry.phase(), EntryPhase::Settled(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admitted(children: &[&str]) -> EntrySettlement {
        let mut entry = EntrySettlement::new();
        for child in children {
            entry
                .apply(SettleEvent::Admit((*child).to_string()))
                .unwrap();
        }
        entry
    }

    fn settled(result: EntryResult) -> EntrySettlement {
        let mut entry = admitted(&["c1"]);
        entry
            .apply(SettleEvent::ChildSettled("c1".to_string()))
            .unwrap();
        entry.apply(SettleEvent::Commit(result)).unwrap();
        entry
    }

    #[test]
    fn an_entry_runs_while_one_child_is_in_flight() {
        let mut entry = admitted(&["c1", "c2"]);
        let phase = entry.apply(SettleEvent::ChildSettled("c1".to_string()));
        assert_eq!(phase, Ok(EntryPhase::Running));
    }

    #[test]
    fn settled_children_without_committed_outputs_do_not_settle_the_entry() {
        let mut entry = admitted(&["c1"]);
        let phase = entry.apply(SettleEvent::ChildSettled("c1".to_string()));
        assert_eq!(phase, Ok(EntryPhase::AwaitingCommit));
    }

    #[test]
    fn an_entry_settles_when_its_children_settled_and_its_outputs_are_committed() {
        assert_eq!(
            settled(EntryResult::Outputs).phase(),
            EntryPhase::Settled(EntryResult::Outputs)
        );
    }

    #[test]
    fn a_committed_failure_settles_the_entry_as_failed() {
        assert_eq!(
            settled(EntryResult::Failed).phase(),
            EntryPhase::Settled(EntryResult::Failed)
        );
    }

    #[test]
    fn a_commit_while_a_child_is_in_flight_is_an_illegal_transition() {
        let mut entry = admitted(&["c1"]);
        assert_eq!(
            entry.apply(SettleEvent::Commit(EntryResult::Outputs)),
            Err(IllegalSettle {
                phase: EntryPhase::Running,
                event: SettleEvent::Commit(EntryResult::Outputs),
            })
        );
        assert_eq!(entry, admitted(&["c1"]));
    }

    #[test]
    fn a_settled_entry_accepts_no_event() {
        let refused: Vec<bool> = [
            SettleEvent::Admit("c2".to_string()),
            SettleEvent::ChildSettled("c1".to_string()),
            SettleEvent::Commit(EntryResult::Failed),
        ]
        .into_iter()
        .map(|event| settled(EntryResult::Outputs).apply(event).is_err())
        .collect();
        assert_eq!(refused, [true; 3]);
    }

    #[test]
    fn a_settle_of_a_child_that_was_not_admitted_is_an_illegal_transition() {
        let mut entry = admitted(&["c1"]);
        assert_eq!(
            entry.apply(SettleEvent::ChildSettled("c9".to_string())),
            Err(IllegalSettle {
                phase: EntryPhase::Running,
                event: SettleEvent::ChildSettled("c9".to_string()),
            })
        );
    }

    #[test]
    fn a_run_is_not_quiescent_while_a_settle_waits_for_evaluation() {
        let entries = [settled(EntryResult::Outputs)];
        assert!(!run_quiescent(1, &entries));
    }

    #[test]
    fn a_run_is_not_quiescent_while_an_entry_waits_for_its_commit() {
        let mut waiting = admitted(&["c1"]);
        waiting
            .apply(SettleEvent::ChildSettled("c1".to_string()))
            .unwrap();
        let entries = [settled(EntryResult::Outputs), waiting];
        assert!(!run_quiescent(0, &entries));
    }

    #[test]
    fn a_run_is_quiescent_when_every_entry_settled_and_no_settle_waits() {
        let entries = [settled(EntryResult::Outputs), settled(EntryResult::Failed)];
        assert!(run_quiescent(0, &entries));
    }
}
