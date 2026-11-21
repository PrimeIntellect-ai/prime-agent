//! Join bookkeeping: a join state waits for a settle of every source.

use std::collections::BTreeSet;

/// The state of one join source, as the executor sees it. The executor
/// gives the first form that applies, in this order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceProgress {
    /// An entry of the source is pending or running. Its own settle
    /// evaluates the join again.
    Live,
    /// A queued settle fires a transition into the source. Evaluate the
    /// join again after the queue is empty.
    ArrivalQueued,
    /// The source has not settled.
    Unsettled,
    /// The index of the source's latest settled entry.
    Settled(u64),
}

/// The result of [`Run::evaluate_join`](super::Run::evaluate_join).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinOutcome {
    Live,
    ArrivalQueued,
    Unsettled,
    /// The join consumed this combination of settles before.
    Stale,
    /// Every source settled. Give the claim to
    /// [`Run::fire`](super::Run::fire).
    Ready(JoinClaim),
}

/// One combination of source settles for one join: the join's canonical
/// transition index and each source's settled entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinClaim {
    index: usize,
    settles: BTreeSet<(String, u64)>,
}

impl JoinClaim {
    /// Collect the settle of each source, or the outcome of the first
    /// source that has not settled.
    pub(crate) fn collect(
        index: usize,
        sources: &[String],
        progress: impl Fn(&str) -> SourceProgress,
    ) -> Result<Self, JoinOutcome> {
        let mut settles = BTreeSet::new();
        for source in sources {
            match progress(source) {
                SourceProgress::Live => return Err(JoinOutcome::Live),
                SourceProgress::ArrivalQueued => return Err(JoinOutcome::ArrivalQueued),
                SourceProgress::Unsettled => return Err(JoinOutcome::Unsettled),
                SourceProgress::Settled(entry) => {
                    settles.insert((source.clone(), entry));
                }
            }
        }
        Ok(Self { index, settles })
    }

    #[must_use]
    pub fn index(&self) -> usize {
        self.index
    }
}
