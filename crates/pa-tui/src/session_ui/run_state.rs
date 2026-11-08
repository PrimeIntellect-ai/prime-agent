//! The client's mirror of the daemon's agent run, and the one writer that also owns whether the
//! working loader shows.
use std::time::Instant;

use super::{AgentView, SessionUi, WorkingState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunState {
    Idle,
    /// A prompt was submitted on an idle session and its run has not started yet.
    Submitted,
    /// `agent_start` .. `agent_end`.
    Running,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunEvent {
    Submitted,
    /// A submit failed or its outcome is unknown; a run the daemon did start still arrives as
    /// `Started`. `others_in_flight` keeps the state while another submit can still start it.
    SubmitFailed {
        others_in_flight: bool,
    },
    /// An abort withdraws a not-yet-started prompt without any frame; a started run still ends
    /// with its `agent_end`.
    Interrupted,
    Started,
    Ended,
    Attached {
        streaming: bool,
    },
}

impl RunState {
    fn next(self, event: RunEvent) -> RunState {
        use RunState::{Idle, Running, Submitted};
        match (self, event) {
            (
                Idle | Submitted | Running,
                RunEvent::Started | RunEvent::Attached { streaming: true },
            ) => Running,
            (
                Idle | Submitted | Running,
                RunEvent::Ended | RunEvent::Attached { streaming: false },
            ) => Idle,
            (Idle, RunEvent::Submitted) => Submitted,
            (
                Submitted,
                RunEvent::Interrupted
                | RunEvent::SubmitFailed {
                    others_in_flight: false,
                },
            ) => Idle,
            (Idle, RunEvent::Interrupted | RunEvent::SubmitFailed { .. })
            | (
                Submitted,
                RunEvent::Submitted
                | RunEvent::SubmitFailed {
                    others_in_flight: true,
                },
            )
            | (
                Running,
                RunEvent::Submitted | RunEvent::Interrupted | RunEvent::SubmitFailed { .. },
            ) => self,
        }
    }
}

impl SessionUi {
    pub(crate) fn run_busy(&self) -> bool {
        match self.run_state {
            RunState::Idle => false,
            RunState::Submitted | RunState::Running => true,
        }
    }

    /// Every run or turn start restarts the loader; a re-attached run anchors it at the LAST
    /// HUMAN PROMPT (the operator's 2026-09-28 rule).
    pub(crate) fn apply_run_event(&mut self, event: RunEvent, view: &mut AgentView) {
        let was = self.run_state;
        self.run_state = was.next(event);
        match self.run_state {
            RunState::Idle => {
                view.working = None;
                view.working_since = None;
                return;
            }
            RunState::Submitted | RunState::Running => {}
        }
        let since = match event {
            RunEvent::Started => Instant::now(),
            RunEvent::Attached { .. } => self
                .loader_anchor_ms
                .and_then(Self::loader_anchor_instant)
                .unwrap_or_else(Instant::now),
            RunEvent::Submitted => match was {
                RunState::Idle => Instant::now(),
                RunState::Submitted | RunState::Running => return,
            },
            RunEvent::SubmitFailed { .. } | RunEvent::Interrupted | RunEvent::Ended => return,
        };
        view.working = Some(WorkingState {
            activity: "Waiting",
            message: None,
            download: false,
            tokens: 0,
            elapsed_secs: 0,
        });
        view.working_since = Some(since);
        self.working_tokens.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::{RunEvent, RunState};

    const FAILED: RunEvent = RunEvent::SubmitFailed {
        others_in_flight: false,
    };

    fn after(events: &[RunEvent]) -> RunState {
        events
            .iter()
            .fold(RunState::Idle, |state, event| state.next(*event))
    }

    #[test]
    fn a_failed_or_lost_submit_never_strands_the_loader() {
        assert_eq!(
            after(&[RunEvent::Submitted, FAILED]),
            RunState::Idle,
            "a refused, unreachable or unanswered submit returns to idle"
        );
        assert_eq!(
            after(&[RunEvent::Submitted, FAILED, RunEvent::Started]),
            RunState::Running,
            "a run the daemon started anyway still shows"
        );
        assert_eq!(
            after(&[RunEvent::Started, RunEvent::Submitted, FAILED]),
            RunState::Running,
            "a queued prompt's failure never ends the live run"
        );
        let other_pending = RunEvent::SubmitFailed {
            others_in_flight: true,
        };
        assert_eq!(
            after(&[RunEvent::Submitted, RunEvent::Submitted, other_pending]),
            RunState::Submitted,
            "a failed submit keeps the state while another submit is still in flight"
        );
        assert_eq!(
            after(&[RunEvent::Submitted, RunEvent::Interrupted]),
            RunState::Idle,
            "an abort before the run starts clears the loader"
        );
        assert_eq!(
            after(&[
                RunEvent::Submitted,
                RunEvent::Interrupted,
                RunEvent::Started
            ]),
            RunState::Running,
            "a prompt the daemon had already picked up still shows its run"
        );
        assert_eq!(
            after(&[RunEvent::Started, RunEvent::Interrupted]),
            RunState::Running,
            "a started run waits for its agent_end"
        );
    }
}
