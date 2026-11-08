//! The turn runner's delivery state, written only through [`TurnState::apply`].

use crate::types::{SessionActionActive, TurnPhase};

pub(crate) enum TurnAbort {
    /// A graceful shutdown stops the turn without cancelling the delivery:
    /// its unaccepted items requeue, and a daemon-wide stop continues it.
    Shutdown,
    Cancelled,
}

struct RunningTurn {
    phase: TurnPhase,
    /// `None` when no queue-visible item anchors the delivery (no active action).
    action_label: Option<String>,
}

pub(crate) enum TurnTransition {
    /// Carries the anchoring item's action label.
    Pickup(Option<String>),
    /// The first accepted row (`committing`) or assistant frame (`running`).
    Advance(TurnPhase),
    /// A successful terminal `Done`.
    Completed,
    /// The turn ended; its facts stay readable until the next pickup.
    Settle,
    /// A cancellation outranks a shutdown.
    Abort(TurnAbort),
    /// A cancellation by a flow that detaches from the interrupted turn's
    /// events (a manual `compact`, a branch navigation): TS swallowed the
    /// aborted row, so the gate's aborted-row exception stays closed until
    /// that flow saw the turn settle ([`TurnTransition::EndRowSuppression`]).
    CancelDetached,
    EndRowSuppression,
    /// `abort_retry`: stops an in-flight retry without aborting the turn.
    AbortRetry,
    NewSession,
}

/// The current delivery (or, once settled, the last one until the next
/// pickup): the settle and the shutdown continuation read its facts after
/// the turn ended.
#[derive(Default)]
pub(crate) struct TurnState {
    running: Option<RunningTurn>,
    abort: Option<TurnAbort>,
    completed: bool,
    retry_abort: bool,
    /// Owned by the detaching flow's drain window, not by the delivery: a
    /// pickup inside that window keeps it.
    suppress_aborted_row: bool,
}

impl TurnState {
    pub(crate) fn apply(&mut self, transition: TurnTransition) {
        match transition {
            TurnTransition::Pickup(action_label) => {
                self.running = Some(RunningTurn {
                    phase: TurnPhase::Preparing,
                    action_label,
                });
                self.abort = None;
                self.completed = false;
                self.retry_abort = false;
            }
            TurnTransition::Advance(phase) => {
                if let Some(running) = self.running.as_mut() {
                    running.phase = phase;
                }
            }
            TurnTransition::Completed => self.completed = true,
            TurnTransition::Settle => self.running = None,
            TurnTransition::Abort(TurnAbort::Shutdown) => {
                self.abort.get_or_insert(TurnAbort::Shutdown);
            }
            TurnTransition::Abort(TurnAbort::Cancelled) => {
                self.abort = Some(TurnAbort::Cancelled);
            }
            TurnTransition::CancelDetached => {
                self.abort = Some(TurnAbort::Cancelled);
                self.suppress_aborted_row = true;
            }
            TurnTransition::EndRowSuppression => self.suppress_aborted_row = false,
            TurnTransition::AbortRetry => self.retry_abort = true,
            TurnTransition::NewSession => {
                self.abort = None;
                self.completed = false;
                self.retry_abort = false;
            }
        }
    }

    pub(crate) fn busy(&self) -> bool {
        self.running.is_some()
    }

    /// Any abort, a graceful shutdown's included.
    pub(crate) fn abort_requested(&self) -> bool {
        self.abort.is_some()
    }

    pub(crate) fn cancelled(&self) -> bool {
        matches!(self.abort, Some(TurnAbort::Cancelled))
    }

    pub(crate) fn suppresses_aborted_row(&self) -> bool {
        self.suppress_aborted_row
    }

    pub(crate) fn completed(&self) -> bool {
        self.completed
    }

    pub(crate) fn retry_abort_requested(&self) -> bool {
        self.retry_abort
    }

    pub(crate) fn active_action(&self) -> Option<SessionActionActive> {
        let running = self.running.as_ref()?;
        Some(SessionActionActive {
            kind: "turn".to_string(),
            phase: running.phase,
            label: Some(running.action_label.clone()?),
        })
    }
}
