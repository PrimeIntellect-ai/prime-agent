//! One child's run status: running, a verdict, or settled once the settle
//! funnel fired. [`RunState::apply`] is its only writer.

#[derive(Debug)]
pub(super) struct RunState(RunPhase);

#[derive(Debug)]
enum RunPhase {
    Running,
    /// A verdict landed; the settle funnel has not fired yet (the terminal
    /// notice window).
    Verdict(RunVerdict),
    /// The settle funnel fired: the quiescence predicate counts the run as done.
    Settled(RunVerdict),
}

/// How a run ended.
#[derive(Debug)]
pub(super) enum RunVerdict {
    Done,
    /// The failure text; `None` only on a reseeded row (a restart relists a
    /// run its display left `running`).
    Error(Option<String>),
    /// The cancel reason; `None` for a close-walk kill.
    Cancelled(Option<String>),
}

pub(super) enum RunEvent {
    /// The worker read idle past the settle grace: `done`, or `error` when the
    /// run's final turn failed.
    IdleRead { final_turn_error: Option<String> },
    /// The task prompt could not be routed, or the worker stayed unreachable.
    Failed(String),
    /// A user abort or a close kill claims the live run before its command.
    Cancel { reason: Option<String> },
    /// The abort or kill was refused: the claimed cancel is undone.
    CancelRefused,
    /// A delete killed the live run: its reason replaces any verdict.
    DeleteCancel,
    /// The settle funnel fired.
    Funnel,
}

impl RunState {
    pub(super) fn running() -> Self {
        Self(RunPhase::Running)
    }

    /// A row rebuilt from the spawn ledger: settled, nothing owed.
    pub(super) fn reseeded(verdict: RunVerdict) -> Self {
        Self(RunPhase::Settled(verdict))
    }

    /// Apply one transition and return whether it changed the state; an event
    /// that does not apply in the current phase changes nothing.
    pub(super) fn apply(&mut self, event: RunEvent) -> bool {
        let (next, changed) = match (std::mem::replace(&mut self.0, RunPhase::Running), event) {
            (RunPhase::Running, RunEvent::IdleRead { final_turn_error }) => (
                RunPhase::Verdict(match final_turn_error {
                    Some(error) => RunVerdict::Error(Some(error)),
                    None => RunVerdict::Done,
                }),
                true,
            ),
            (RunPhase::Running, RunEvent::Failed(error)) => {
                (RunPhase::Verdict(RunVerdict::Error(Some(error))), true)
            }
            (RunPhase::Running, RunEvent::Cancel { reason }) => {
                (RunPhase::Verdict(RunVerdict::Cancelled(reason)), true)
            }
            (RunPhase::Verdict(RunVerdict::Cancelled(_)), RunEvent::CancelRefused) => {
                (RunPhase::Running, true)
            }
            (RunPhase::Running | RunPhase::Verdict(_), RunEvent::DeleteCancel) => {
                (RunPhase::Verdict(deleted_by_parent()), true)
            }
            (RunPhase::Settled(_), RunEvent::DeleteCancel) => {
                (RunPhase::Settled(deleted_by_parent()), true)
            }
            (RunPhase::Verdict(verdict), RunEvent::Funnel) => (RunPhase::Settled(verdict), true),
            (phase @ RunPhase::Running, RunEvent::CancelRefused | RunEvent::Funnel)
            | (
                phase @ (RunPhase::Verdict(_) | RunPhase::Settled(_)),
                RunEvent::IdleRead { .. }
                | RunEvent::Failed(_)
                | RunEvent::Cancel { .. }
                | RunEvent::CancelRefused,
            )
            | (phase @ RunPhase::Settled(_), RunEvent::Funnel) => (phase, false),
        };
        self.0 = next;
        changed
    }

    pub(super) fn status(&self) -> &'static str {
        match self.verdict() {
            None => "running",
            Some(RunVerdict::Done) => "done",
            Some(RunVerdict::Error(_)) => "error",
            Some(RunVerdict::Cancelled(_)) => "cancelled",
        }
    }

    pub(super) fn is_running(&self) -> bool {
        matches!(self.0, RunPhase::Running)
    }

    pub(super) fn verdict(&self) -> Option<&RunVerdict> {
        match &self.0 {
            RunPhase::Running => None,
            RunPhase::Verdict(verdict) | RunPhase::Settled(verdict) => Some(verdict),
        }
    }

    pub(super) fn funnel_fired(&self) -> bool {
        matches!(self.0, RunPhase::Settled(_))
    }

    /// The verdict's text: the failure text or the cancel reason.
    pub(super) fn error(&self) -> Option<&str> {
        match self.verdict() {
            Some(RunVerdict::Error(text) | RunVerdict::Cancelled(text)) => text.as_deref(),
            Some(RunVerdict::Done) | None => None,
        }
    }
}

fn deleted_by_parent() -> RunVerdict {
    RunVerdict::Cancelled(Some("Deleted by parent orchestrator".to_string()))
}
