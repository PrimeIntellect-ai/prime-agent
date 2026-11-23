//! One child's run and task-prompt state. [`RunState::apply`] is their only writer.

use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Debug)]
pub(super) struct RunState {
    phase: RunPhase,
    prompt: PromptPhase,
    changed: Arc<Notify>,
}

#[derive(Debug)]
enum PromptPhase {
    Held,
    Released,
    Admitted,
}

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
    /// Release the detached task sender from the parent's turn boundary.
    ReleasePrompt,
    /// The child worker admitted its task prompt.
    PromptAdmitted,
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
    pub(super) fn held() -> Self {
        Self {
            phase: RunPhase::Running,
            prompt: PromptPhase::Held,
            changed: Arc::new(Notify::new()),
        }
    }

    #[cfg(test)]
    pub(super) fn admitted() -> Self {
        Self {
            phase: RunPhase::Running,
            prompt: PromptPhase::Admitted,
            changed: Arc::new(Notify::new()),
        }
    }

    /// A row rebuilt from the spawn ledger: settled, nothing owed.
    pub(super) fn reseeded(verdict: RunVerdict) -> Self {
        Self {
            phase: RunPhase::Settled(verdict),
            prompt: PromptPhase::Admitted,
            changed: Arc::new(Notify::new()),
        }
    }

    /// Apply one transition and return whether it changed the state; an event
    /// that does not apply in the current phase changes nothing.
    pub(super) fn apply(&mut self, event: RunEvent) -> bool {
        let admitted = self.prompt_admitted();
        let (next, changed) = match (std::mem::replace(&mut self.phase, RunPhase::Running), event) {
            (phase, RunEvent::ReleasePrompt) => {
                let held = matches!(self.prompt, PromptPhase::Held);
                if held {
                    self.prompt = PromptPhase::Released;
                }
                (phase, held)
            }
            (phase, RunEvent::PromptAdmitted) => {
                self.prompt = PromptPhase::Admitted;
                (phase, true)
            }
            (RunPhase::Running, RunEvent::IdleRead { final_turn_error }) if admitted => (
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
            (
                phase @ RunPhase::Running,
                RunEvent::IdleRead { .. } | RunEvent::CancelRefused | RunEvent::Funnel,
            )
            | (
                phase @ (RunPhase::Verdict(_) | RunPhase::Settled(_)),
                RunEvent::IdleRead { .. }
                | RunEvent::Failed(_)
                | RunEvent::Cancel { .. }
                | RunEvent::CancelRefused,
            )
            | (phase @ RunPhase::Settled(_), RunEvent::Funnel) => (phase, false),
        };
        self.phase = next;
        if changed {
            self.changed.notify_waiters();
        }
        changed
    }

    pub(super) fn notifier(&self) -> Arc<Notify> {
        Arc::clone(&self.changed)
    }

    pub(super) fn prompt_released(&self) -> bool {
        !matches!(self.prompt, PromptPhase::Held)
    }

    pub(super) fn prompt_admitted(&self) -> bool {
        matches!(self.prompt, PromptPhase::Admitted)
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
        matches!(self.phase, RunPhase::Running)
    }

    pub(super) fn verdict(&self) -> Option<&RunVerdict> {
        match &self.phase {
            RunPhase::Running => None,
            RunPhase::Verdict(verdict) | RunPhase::Settled(verdict) => Some(verdict),
        }
    }

    pub(super) fn funnel_fired(&self) -> bool {
        matches!(self.phase, RunPhase::Settled(_))
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

    #[test]
    fn prompt_release_is_idempotent_and_admission_ends_it() {
        let mut run = RunState::held();
        assert!(run.apply(RunEvent::ReleasePrompt));
        assert!(!run.apply(RunEvent::ReleasePrompt));
        assert!(run.prompt_released());
        assert!(!run.prompt_admitted());

        assert!(run.apply(RunEvent::PromptAdmitted));
        assert!(run.prompt_admitted());
        assert!(!run.apply(RunEvent::ReleasePrompt));
        assert!(run.prompt_admitted());
    }

    #[test]
    fn late_admission_and_cancel_refusal_preserve_the_cancelled_verdict() {
        let mut run = RunState::held();
        run.apply(RunEvent::ReleasePrompt);
        assert!(run.apply(RunEvent::Cancel { reason: None }));
        assert_eq!(run.status(), "cancelled");

        assert!(run.apply(RunEvent::PromptAdmitted));
        assert_eq!(run.status(), "cancelled");
        assert!(run.prompt_admitted());

        assert!(run.apply(RunEvent::CancelRefused));
        assert!(run.is_running());
        assert!(run.prompt_admitted());
    }
}
