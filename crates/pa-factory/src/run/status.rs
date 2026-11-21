//! The run status and the only transitions between statuses.

use std::fmt;

/// The status of one live run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    /// The run admits children and fires transitions.
    Running,
    /// The run waits for the operator. Children in flight keep running.
    Paused(PauseReason),
    /// The run retires its children.
    Stopping,
    /// Every entry settled without an error.
    Done,
    /// A failure ended the run.
    Failed,
    /// The operator stopped the run, and its children are retired.
    Stopped,
}

/// Why a run paused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PauseReason {
    /// A state failed under the `escalate` failure policy.
    Escalate,
    /// The run used its active-time budget.
    Budget,
    /// The run fired `max_transitions` transitions.
    MaxTransitions,
    /// The run admitted `max_children` agent children.
    MaxChildren,
}

/// One input to the run status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEvent {
    /// Start one child.
    Admit,
    /// Fire one transition.
    Fire,
    Pause(PauseReason),
    /// The operator continues a paused run.
    Resume,
    /// Every entry settled without an error.
    Finish,
    Fail,
    /// The operator stops the run. A done or failed run can stop to
    /// retire its resident children.
    Stop,
    /// The last child is retired.
    StopComplete,
}

impl RunStatus {
    /// The status after `event`.
    ///
    /// # Errors
    ///
    /// Returns an [`IllegalTransition`] when this status does not accept
    /// `event`.
    pub fn next(self, event: RunEvent) -> Result<Self, IllegalTransition> {
        use RunEvent as E;
        use RunStatus as S;
        match (self, event) {
            (S::Running, E::Admit | E::Fire) | (S::Paused(_), E::Resume) => Ok(S::Running),
            (S::Running, E::Pause(reason)) => Ok(S::Paused(reason)),
            (S::Running, E::Finish) => Ok(S::Done),
            (S::Running, E::Fail) => Ok(S::Failed),
            (S::Running | S::Paused(_) | S::Stopping | S::Done | S::Failed, E::Stop) => {
                Ok(S::Stopping)
            }
            (S::Stopping, E::StopComplete) => Ok(S::Stopped),
            (S::Running, E::Resume | E::StopComplete)
            | (
                S::Paused(_),
                E::Admit | E::Fire | E::Pause(_) | E::Finish | E::Fail | E::StopComplete,
            )
            | (S::Stopping, E::Admit | E::Fire | E::Pause(_) | E::Resume | E::Finish | E::Fail)
            | (
                S::Done | S::Failed,
                E::Admit
                | E::Fire
                | E::Pause(_)
                | E::Resume
                | E::Finish
                | E::Fail
                | E::StopComplete,
            )
            | (
                S::Stopped,
                E::Admit
                | E::Fire
                | E::Pause(_)
                | E::Resume
                | E::Finish
                | E::Fail
                | E::Stop
                | E::StopComplete,
            ) => Err(IllegalTransition { from: self, event }),
        }
    }

    #[must_use]
    pub fn is_paused(self) -> bool {
        matches!(self, Self::Paused(_))
    }

    /// The executor's wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused(_) => "paused",
            Self::Stopping => "stopping",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

/// An event that the run's status does not accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IllegalTransition {
    pub from: RunStatus,
    pub event: RunEvent,
}

impl fmt::Display for IllegalTransition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "illegal run transition: {:?} while {}",
            self.event,
            self.from.as_str()
        )
    }
}

impl std::error::Error for IllegalTransition {}
