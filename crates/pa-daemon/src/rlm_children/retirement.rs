//! One child's retirement (delete or close): live, a kill in flight, or a
//! confirmed kill whose finish steps run once each across interrupted
//! retries. [`Retirement::apply`] is its only writer.

#[derive(Debug)]
pub(super) struct Retirement(RetirementPhase);

#[derive(Debug)]
enum RetirementPhase {
    Live,
    /// A delete of a running child waits for its kill.
    Deleting,
    /// The close walk claimed the child before its kill.
    Closing,
    /// The kill is confirmed (or the session was already gone); `step` is
    /// the last finish step claimed.
    Confirmed {
        intent: RetirementIntent,
        step: FinishStep,
    },
}

#[derive(Debug, Clone, Copy)]
pub(super) enum RetirementIntent {
    Delete { was_running: bool },
    Close,
}

/// The finish steps of a confirmed retirement, in the order
/// `finish_retirement` claims them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum FinishStep {
    Pending,
    RosterEmitted,
    Notified,
    Finished,
}

pub(super) enum RetirementEvent {
    /// A delete of a running child sends its kill.
    BeginDelete,
    /// The close walk sends its kill.
    BeginClose,
    /// The delete's kill was refused: the child stays live and watched.
    KillRefused,
    /// The kill landed; the first confirmed intent stands.
    KillConfirmed(RetirementIntent),
    /// Claim one finish step; a step claimed before is not claimed again.
    Claim(FinishStep),
}

impl Retirement {
    pub(super) fn live() -> Self {
        Self(RetirementPhase::Live)
    }

    /// Apply one transition and return whether it changed the state; an event
    /// that does not apply in the current phase changes nothing.
    pub(super) fn apply(&mut self, event: RetirementEvent) -> bool {
        let next = match (&self.0, event) {
            (RetirementPhase::Live, RetirementEvent::BeginDelete) => RetirementPhase::Deleting,
            (RetirementPhase::Live, RetirementEvent::BeginClose) => RetirementPhase::Closing,
            (RetirementPhase::Deleting, RetirementEvent::KillRefused) => RetirementPhase::Live,
            (
                RetirementPhase::Live | RetirementPhase::Deleting | RetirementPhase::Closing,
                RetirementEvent::KillConfirmed(intent),
            ) => RetirementPhase::Confirmed {
                intent,
                step: FinishStep::Pending,
            },
            (RetirementPhase::Confirmed { intent, step }, RetirementEvent::Claim(claimed))
                if *step < claimed =>
            {
                RetirementPhase::Confirmed {
                    intent: *intent,
                    step: claimed,
                }
            }
            _ => return false,
        };
        self.0 = next;
        true
    }

    /// The parent closed this child, or confirmed its kill: watchers stop and
    /// no terminal notice is owed to a child being torn down.
    pub(super) fn closed_by_parent(&self) -> bool {
        matches!(
            self.0,
            RetirementPhase::Closing | RetirementPhase::Confirmed { .. }
        )
    }

    /// A delete of the live run owns its terminal edge: a settle watcher that
    /// wakes inside the kill window parks and records no clean
    /// `child_returned` (the delete records a cancel edge instead).
    pub(super) fn retiring(&self) -> bool {
        matches!(
            self.0,
            RetirementPhase::Deleting
                | RetirementPhase::Confirmed {
                    intent: RetirementIntent::Delete { was_running: true },
                    ..
                }
        )
    }

    /// The confirmed kill's intent; `None` until the kill landed.
    pub(super) fn intent(&self) -> Option<RetirementIntent> {
        match self.0 {
            RetirementPhase::Confirmed { intent, .. } => Some(intent),
            RetirementPhase::Live | RetirementPhase::Deleting | RetirementPhase::Closing => None,
        }
    }

    pub(super) fn finished(&self) -> bool {
        matches!(
            self.0,
            RetirementPhase::Confirmed {
                step: FinishStep::Finished,
                ..
            }
        )
    }
}
