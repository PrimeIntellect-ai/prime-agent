//! Run and state budgets.

/// A python call's time limit when neither the state nor the run sets a
/// budget.
pub const PYTHON_TIME_LIMIT_MS_DEFAULT: u64 = 60_000;

/// The run's active-time count, in milliseconds. Paused time is not
/// active time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RunClock {
    started_at: u64,
    paused: u64,
    pause_started_at: Option<u64>,
}

impl RunClock {
    pub(crate) fn new(now_ms: u64) -> Self {
        Self {
            started_at: now_ms,
            paused: 0,
            pause_started_at: None,
        }
    }

    pub(crate) fn pause(&mut self, now_ms: u64) {
        self.pause_started_at.get_or_insert(now_ms);
    }

    pub(crate) fn resume(&mut self, now_ms: u64) {
        if let Some(started) = self.pause_started_at.take() {
            self.paused += now_ms.saturating_sub(started);
        }
    }

    pub(crate) fn active_ms(&self, now_ms: u64) -> u64 {
        let open_pause = self
            .pause_started_at
            .map_or(0, |started| now_ms.saturating_sub(started));
        now_ms
            .saturating_sub(self.started_at)
            .saturating_sub(self.paused)
            .saturating_sub(open_pause)
    }
}

/// The time limit of one python call: the state's budget, then the run's
/// budget, then [`PYTHON_TIME_LIMIT_MS_DEFAULT`].
#[must_use]
pub fn python_time_limit_ms(state_budget_ms: Option<u64>, run_budget_ms: Option<u64>) -> u64 {
    state_budget_ms
        .or(run_budget_ms)
        .unwrap_or(PYTHON_TIME_LIMIT_MS_DEFAULT)
}

/// The elapsed time of a settled child when it is more than the state's
/// budget, else `None`.
///
/// The budget measures the child's own run time (`child_run_ms`), so a
/// child that settled in budget while the run was paused keeps its work.
/// When the child's run time is zero (unknown), the wall time since
/// admission (`wall_ms`) applies. An overrun spends the budget: the entry
/// does not retry, and its failure policy applies.
#[must_use]
pub fn state_budget_overrun(budget_ms: u64, child_run_ms: u64, wall_ms: u64) -> Option<u64> {
    let elapsed = if child_run_ms == 0 {
        wall_ms
    } else {
        child_run_ms
    };
    (elapsed > budget_ms).then_some(elapsed)
}
