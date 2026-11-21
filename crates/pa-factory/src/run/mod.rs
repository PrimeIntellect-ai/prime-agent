//! The rules a live run follows: its status, its joins, its budgets, its
//! transitions, its owner, and its quiescence.
//!
//! The executor owns the clock, the children, and the files. This module
//! owns the decisions. Each call that reads time takes it from the caller
//! (`now_ms`). A run changes status only through a [`RunEvent`]. When the
//! current status does not accept an event, the call returns an
//! [`IllegalTransition`] and changes nothing.

mod budget;
mod join;
mod ownership;
mod quiescence;
mod status;
mod transitions;

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use budget::RunClock;
pub use budget::{python_time_limit_ms, state_budget_overrun, PYTHON_TIME_LIMIT_MS_DEFAULT};
pub use join::{JoinClaim, JoinOutcome, SourceProgress};
pub use ownership::{OwnedRun, Ownership, OwnershipError};
pub use quiescence::{
    run_quiescent, EntryPhase, EntryResult, EntrySettlement, IllegalSettle, SettleEvent,
};
pub use status::{IllegalTransition, PauseReason, RunEvent, RunStatus};
pub use transitions::{Guard, Sources, SpecError, Transition, TransitionIndex};

/// The highest `max_transitions` a run accepts.
pub const MAX_TRANSITIONS_CAP: u64 = 10_000;
/// The `max_transitions` default for each state, up to the cap.
pub const TRANSITIONS_PER_STATE_DEFAULT: u64 = 10;
/// The `max_children` default.
pub const MAX_CHILDREN_DEFAULT: u64 = 10_000;

/// The bounds of one run, from the canonical spec's `run` block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunLimits {
    /// The active time the run can use. `None` means no limit.
    pub budget_ms: Option<u64>,
    /// The fired transitions before the run pauses.
    pub max_transitions: u64,
    /// The agent children the run can admit before it pauses.
    pub max_children: u64,
}

impl RunLimits {
    /// Read the limits from a canonical spec. An absent field takes the
    /// executor's default: `max_transitions` is 10 for each state, up to
    /// [`MAX_TRANSITIONS_CAP`].
    #[must_use]
    pub fn from_spec(spec: &Value) -> Self {
        let run = spec.get("run");
        let field = |key: &str| run.and_then(|run| run.get(key)).and_then(Value::as_u64);
        let states = spec
            .get("states")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let per_state = TRANSITIONS_PER_STATE_DEFAULT.saturating_mul(states as u64);
        Self {
            budget_ms: field("budget_ms"),
            max_transitions: field("max_transitions")
                .unwrap_or_else(|| per_state.min(MAX_TRANSITIONS_CAP)),
            max_children: field("max_children").unwrap_or(MAX_CHILDREN_DEFAULT),
        }
    }
}

/// What a child runs, for the child budget: only agent children count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildKind {
    Agent,
    Python,
}

/// The result of an admission check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Start the child.
    Admit,
    /// The run paused for this reason. Do not start the child.
    Paused(PauseReason),
}

/// One transition to fire from a settled state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fire {
    /// The entries the target state used.
    pub target_entries_used: u64,
    /// The target state's `max_entries`.
    pub target_max_entries: u64,
    /// The claim from [`Run::evaluate_join`] when the transition is a join.
    pub join: Option<JoinClaim>,
}

/// The result of [`Run::fire`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FireOutcome {
    /// The transition fired. Enter the target state.
    Fired,
    /// The target state used all its entries. Nothing enters it.
    Blocked,
    /// The run reached `max_transitions` and paused. The transition did
    /// not fire. Fire it again after the run resumes.
    Paused,
}

/// The decision state of one live run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    status: RunStatus,
    limits: RunLimits,
    transitions: TransitionIndex,
    clock: RunClock,
    transitions_fired: u64,
    children_admitted: u64,
    /// The pauses that occur one time for each run. After the operator
    /// resumes, the same limit does not pause the run again.
    reported: BTreeSet<PauseReason>,
    /// The last settle combination that each join consumed, by the
    /// join's canonical transition index.
    join_fired: BTreeMap<usize, JoinClaim>,
}

impl Run {
    /// Start a run of a canonical spec at `now_ms`. The run starts in
    /// [`RunStatus::Running`].
    ///
    /// # Errors
    ///
    /// Returns a [`SpecError`] when the spec's transitions are malformed.
    pub fn start(spec: &Value, now_ms: u64) -> Result<Self, SpecError> {
        Ok(Self {
            status: RunStatus::Running,
            limits: RunLimits::from_spec(spec),
            transitions: TransitionIndex::from_spec(spec)?,
            clock: RunClock::new(now_ms),
            transitions_fired: 0,
            children_admitted: 0,
            reported: BTreeSet::new(),
            join_fired: BTreeMap::new(),
        })
    }

    #[must_use]
    pub fn status(&self) -> RunStatus {
        self.status
    }

    #[must_use]
    pub fn limits(&self) -> RunLimits {
        self.limits
    }

    #[must_use]
    pub fn transitions(&self) -> &TransitionIndex {
        &self.transitions
    }

    #[must_use]
    pub fn transitions_fired(&self) -> u64 {
        self.transitions_fired
    }

    /// The time the run was active: wall time less paused time. The time
    /// that the run waits for the operator does not use the budget.
    #[must_use]
    pub fn active_ms(&self, now_ms: u64) -> u64 {
        self.clock.active_ms(now_ms)
    }

    /// Apply one event. A pause starts the paused-time count. A resume
    /// stops it.
    ///
    /// # Errors
    ///
    /// Returns an [`IllegalTransition`] when the current status does not
    /// accept the event. The run does not change.
    pub fn apply(&mut self, event: RunEvent, now_ms: u64) -> Result<RunStatus, IllegalTransition> {
        let next = self.status.next(event)?;
        match (self.status.is_paused(), next.is_paused()) {
            (false, true) => self.clock.pause(now_ms),
            (true, false) => self.clock.resume(now_ms),
            (false, false) | (true, true) => {}
        }
        self.status = next;
        Ok(next)
    }

    /// Check the run budget and the child budget before one child starts.
    /// The run budget applies to all children. The child budget applies
    /// to agent children only. Each budget pauses the run one time.
    ///
    /// # Errors
    ///
    /// Returns an [`IllegalTransition`] when the run is not running.
    pub fn admit(&mut self, child: ChildKind, now_ms: u64) -> Result<Admission, IllegalTransition> {
        self.status.next(RunEvent::Admit)?;
        let over_budget = self
            .limits
            .budget_ms
            .is_some_and(|limit| self.clock.active_ms(now_ms) > limit);
        if over_budget && self.report(PauseReason::Budget) {
            self.apply(RunEvent::Pause(PauseReason::Budget), now_ms)?;
            return Ok(Admission::Paused(PauseReason::Budget));
        }
        if child == ChildKind::Agent {
            if self.children_admitted >= self.limits.max_children
                && self.report(PauseReason::MaxChildren)
            {
                self.apply(RunEvent::Pause(PauseReason::MaxChildren), now_ms)?;
                return Ok(Admission::Paused(PauseReason::MaxChildren));
            }
            self.children_admitted += 1;
        }
        Ok(Admission::Admit)
    }

    /// Decide whether the join at canonical transition `index` can fire.
    /// `progress` tells the state of each source. The first source that
    /// has not settled decides the outcome. A join fires one time for
    /// each combination of source settles.
    ///
    /// Returns `None` when `index` is not a join transition.
    pub fn evaluate_join(
        &self,
        index: usize,
        progress: impl Fn(&str) -> SourceProgress,
    ) -> Option<JoinOutcome> {
        let Sources::Join(sources) = &self.transitions.get(index)?.from else {
            return None;
        };
        let claim = match JoinClaim::collect(index, sources, progress) {
            Ok(claim) => claim,
            Err(outcome) => return Some(outcome),
        };
        if self.join_fired.get(&index) == Some(&claim) {
            return Some(JoinOutcome::Stale);
        }
        Some(JoinOutcome::Ready(claim))
    }

    /// Fire one transition. A target with no entries left blocks the
    /// transition. When the run reaches `max_transitions`, the run pauses
    /// one time and the transition does not fire. A join's settle
    /// combination is consumed when the transition fires or is blocked,
    /// but not when the run pauses.
    ///
    /// # Errors
    ///
    /// Returns an [`IllegalTransition`] when the run is not running.
    pub fn fire(&mut self, fire: Fire, now_ms: u64) -> Result<FireOutcome, IllegalTransition> {
        self.status.next(RunEvent::Fire)?;
        if fire.target_entries_used >= fire.target_max_entries {
            self.consume(fire.join);
            return Ok(FireOutcome::Blocked);
        }
        if self.transitions_fired >= self.limits.max_transitions
            && self.report(PauseReason::MaxTransitions)
        {
            self.apply(RunEvent::Pause(PauseReason::MaxTransitions), now_ms)?;
            return Ok(FireOutcome::Paused);
        }
        self.consume(fire.join);
        self.transitions_fired += 1;
        Ok(FireOutcome::Fired)
    }

    fn consume(&mut self, join: Option<JoinClaim>) {
        if let Some(claim) = join {
            self.join_fired.insert(claim.index(), claim);
        }
    }

    /// Mark a one-time pause as reported. Returns `false` when it was
    /// reported before.
    fn report(&mut self, reason: PauseReason) -> bool {
        self.reported.insert(reason)
    }
}

#[cfg(test)]
mod tests;
