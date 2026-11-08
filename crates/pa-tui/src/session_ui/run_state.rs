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
    Started,
    Ended,
    Attached {
        streaming: bool,
    },
}

impl RunState {
    fn next(self, event: RunEvent) -> RunState {
        match event {
            RunEvent::Started | RunEvent::Attached { streaming: true } => RunState::Running,
            RunEvent::Ended | RunEvent::Attached { streaming: false } => RunState::Idle,
            RunEvent::Submitted if self == RunState::Idle => RunState::Submitted,
            RunEvent::SubmitFailed {
                others_in_flight: false,
            } if self == RunState::Submitted => RunState::Idle,
            RunEvent::Submitted | RunEvent::SubmitFailed { .. } => self,
        }
    }
}

impl SessionUi {
    pub(crate) fn run_busy(&self) -> bool {
        self.run_state != RunState::Idle
    }

    /// Every run or turn start restarts the loader; a re-attached run anchors it at the LAST
    /// HUMAN PROMPT (the operator's 2026-09-28 rule).
    pub(crate) fn apply_run_event(&mut self, event: RunEvent, view: &mut AgentView) {
        let was = self.run_state;
        self.run_state = was.next(event);
        if self.run_state == RunState::Idle {
            view.working = None;
            view.working_since = None;
            return;
        }
        let since = match event {
            RunEvent::Started => Instant::now(),
            RunEvent::Attached { .. } => self
                .loader_anchor_ms
                .and_then(Self::loader_anchor_instant)
                .unwrap_or_else(Instant::now),
            RunEvent::Submitted if was == RunState::Idle => Instant::now(),
            _ => return,
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
    }
}
