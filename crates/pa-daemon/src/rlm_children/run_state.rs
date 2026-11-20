//! One child's run and task-prompt state. [`RunState::apply`] is their only writer.

use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Debug)]
pub(super) struct RunState {
    phase: RunPhase,
    changed: Arc<Notify>,
}

#[derive(Debug, Clone)]
enum PromptPhase {
    Held,
    Released,
    Admitted,
}

#[derive(Debug, Clone)]
enum RunPhase {
    Running(PromptPhase),
    /// A verdict landed; the settle funnel has not fired yet (the terminal
    /// notice window).
    Verdict(RunVerdict, PromptPhase),
    /// The settle funnel fired: the quiescence predicate counts the run as done.
    Settled(RunVerdict, PromptPhase),
}

/// How a run ended.
#[derive(Debug, Clone)]
pub(super) enum RunVerdict {
    Done,
    /// The failure text; `None` only on a reseeded row (a restart relists a
    /// run its display left `running`).
    Error(Option<String>),
    /// The cancel reason; `None` for a close-walk kill.
    Cancelled(Option<String>),
}

pub(super) enum RunEvent {
    /// Release the detached task sender from the parent's turn boundary.
    ReleasePrompt,
    /// The child worker accepted its task prompt.
    PromptAccepted,
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
        Self {
            phase: RunPhase::Running(PromptPhase::Held),
            changed: Arc::new(Notify::new()),
        }
    }

    #[cfg(test)]
    pub(super) fn admitted() -> Self {
        Self {
            phase: RunPhase::Running(PromptPhase::Admitted),
            changed: Arc::new(Notify::new()),
        }
    }

    /// A row rebuilt from the spawn ledger: settled, nothing owed.
    pub(super) fn reseeded(verdict: RunVerdict) -> Self {
        Self {
            phase: RunPhase::Settled(verdict, PromptPhase::Admitted),
            changed: Arc::new(Notify::new()),
        }
    }

    /// Apply one transition and return whether it changed the state; an event
    /// that is illegal for the current prompt phase panics rather than hiding
    /// an admission-ordering bug.
    pub(super) fn apply(&mut self, event: RunEvent) -> bool {
        let (next, changed) = match (self.phase.clone(), event) {
            (RunPhase::Running(PromptPhase::Held), RunEvent::ReleasePrompt) => {
                (RunPhase::Running(PromptPhase::Released), true)
            }
            (RunPhase::Verdict(verdict, PromptPhase::Held), RunEvent::ReleasePrompt) => {
                (RunPhase::Verdict(verdict, PromptPhase::Released), true)
            }
            (RunPhase::Settled(verdict, PromptPhase::Held), RunEvent::ReleasePrompt) => {
                (RunPhase::Settled(verdict, PromptPhase::Released), true)
            }
            (RunPhase::Running(PromptPhase::Released), RunEvent::PromptAccepted) => {
                (RunPhase::Running(PromptPhase::Admitted), true)
            }
            (RunPhase::Verdict(verdict, PromptPhase::Released), RunEvent::PromptAccepted) => {
                (RunPhase::Verdict(verdict, PromptPhase::Admitted), true)
            }
            (RunPhase::Settled(verdict, PromptPhase::Released), RunEvent::PromptAccepted) => {
                (RunPhase::Settled(verdict, PromptPhase::Admitted), true)
            }
            (
                RunPhase::Running(PromptPhase::Held)
                | RunPhase::Verdict(_, PromptPhase::Held)
                | RunPhase::Settled(_, PromptPhase::Held),
                RunEvent::PromptAccepted,
            ) => panic!("task prompt accepted before it was released"),
            (
                RunPhase::Running(PromptPhase::Admitted)
                | RunPhase::Verdict(_, PromptPhase::Admitted)
                | RunPhase::Settled(_, PromptPhase::Admitted),
                RunEvent::PromptAccepted,
            ) => panic!("task prompt accepted more than once"),

            (RunPhase::Running(PromptPhase::Admitted), RunEvent::IdleRead { final_turn_error }) => {
                (
                    RunPhase::Verdict(
                        match final_turn_error {
                            Some(error) => RunVerdict::Error(Some(error)),
                            None => RunVerdict::Done,
                        },
                        PromptPhase::Admitted,
                    ),
                    true,
                )
            }
            (
                RunPhase::Running(PromptPhase::Held | PromptPhase::Released),
                RunEvent::IdleRead { .. },
            ) => {
                panic!("child read idle before its task prompt was accepted")
            }
            (RunPhase::Running(prompt), RunEvent::Failed(error)) => (
                RunPhase::Verdict(RunVerdict::Error(Some(error)), prompt),
                true,
            ),
            (RunPhase::Running(prompt), RunEvent::Cancel { reason }) => (
                RunPhase::Verdict(RunVerdict::Cancelled(reason), prompt),
                true,
            ),
            (RunPhase::Verdict(RunVerdict::Cancelled(_), prompt), RunEvent::CancelRefused) => {
                (RunPhase::Running(prompt), true)
            }
            (RunPhase::Running(prompt) | RunPhase::Verdict(_, prompt), RunEvent::DeleteCancel) => {
                (RunPhase::Verdict(deleted_by_parent(), prompt), true)
            }
            (RunPhase::Settled(_, prompt), RunEvent::DeleteCancel) => {
                (RunPhase::Settled(deleted_by_parent(), prompt), true)
            }
            (RunPhase::Verdict(verdict, prompt), RunEvent::Funnel) => {
                (RunPhase::Settled(verdict, prompt), true)
            }
            (
                phase @ (RunPhase::Running(PromptPhase::Released | PromptPhase::Admitted)
                | RunPhase::Verdict(_, PromptPhase::Released | PromptPhase::Admitted)
                | RunPhase::Settled(_, PromptPhase::Released | PromptPhase::Admitted)),
                RunEvent::ReleasePrompt,
            )
            | (phase @ RunPhase::Running(_), RunEvent::CancelRefused | RunEvent::Funnel)
            | (
                phase @ (RunPhase::Verdict(_, _) | RunPhase::Settled(_, _)),
                RunEvent::IdleRead { .. }
                | RunEvent::Failed(_)
                | RunEvent::Cancel { .. }
                | RunEvent::CancelRefused,
            )
            | (phase @ RunPhase::Settled(_, _), RunEvent::Funnel) => (phase, false),
        };
        if changed {
            self.phase = next;
            self.changed.notify_waiters();
        }
        changed
    }

    pub(super) fn notifier(&self) -> Arc<Notify> {
        Arc::clone(&self.changed)
    }

    pub(super) fn prompt_released(&self) -> bool {
        matches!(
            &self.phase,
            RunPhase::Running(PromptPhase::Released | PromptPhase::Admitted)
                | RunPhase::Verdict(_, PromptPhase::Released | PromptPhase::Admitted)
                | RunPhase::Settled(_, PromptPhase::Released | PromptPhase::Admitted)
        )
    }

    pub(super) fn prompt_admitted(&self) -> bool {
        matches!(
            &self.phase,
            RunPhase::Running(PromptPhase::Admitted)
                | RunPhase::Verdict(_, PromptPhase::Admitted)
                | RunPhase::Settled(_, PromptPhase::Admitted)
        )
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
        matches!(&self.phase, RunPhase::Running(_))
    }

    pub(super) fn verdict(&self) -> Option<&RunVerdict> {
        match &self.phase {
            RunPhase::Running(_) => None,
            RunPhase::Verdict(verdict, _) | RunPhase::Settled(verdict, _) => Some(verdict),
        }
    }

    pub(super) fn funnel_fired(&self) -> bool {
        matches!(&self.phase, RunPhase::Settled(_, _))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::AssertUnwindSafe;

    #[test]
    fn prompt_release_is_idempotent_and_admission_is_one_shot() {
        let mut run = RunState::running();
        assert!(run.apply(RunEvent::ReleasePrompt));
        assert!(!run.apply(RunEvent::ReleasePrompt));
        assert!(run.prompt_released());
        assert!(!run.prompt_admitted());

        assert!(run.apply(RunEvent::PromptAccepted));
        assert!(run.prompt_admitted());
        assert!(!run.apply(RunEvent::ReleasePrompt));
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| {
            run.apply(RunEvent::PromptAccepted)
        }))
        .is_err());
    }

    #[test]
    fn admission_before_release_and_idle_before_admission_are_rejected() {
        let mut held = RunState::running();
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| {
            held.apply(RunEvent::PromptAccepted)
        }))
        .is_err());

        let mut held = RunState::running();
        assert!(std::panic::catch_unwind(AssertUnwindSafe(|| {
            held.apply(RunEvent::IdleRead {
                final_turn_error: None,
            })
        }))
        .is_err());
    }

    #[test]
    fn late_admission_and_cancel_refusal_preserve_the_cancelled_verdict() {
        let mut run = RunState::running();
        run.apply(RunEvent::ReleasePrompt);
        assert!(run.apply(RunEvent::Cancel { reason: None }));
        assert_eq!(run.status(), "cancelled");

        assert!(run.apply(RunEvent::PromptAccepted));
        assert_eq!(run.status(), "cancelled");
        assert!(run.prompt_admitted());

        assert!(run.apply(RunEvent::CancelRefused));
        assert!(run.is_running());
        assert!(run.prompt_admitted());
    }
}
