//! The worker's wake for newly queued work.

use std::sync::Arc;

use pa_core::kernel::cell_wake::CellWake;
use tokio::sync::futures::Notified;
use tokio::sync::Notify;

/// Wakes the turn runner and, through the session's cell wake, a running
/// cell's wait. The cell wake's level predicate (the steering lane) decides
/// whether the new input ends that wait, so every route that queues work
/// reaches a sleeping cell without a call of its own.
pub(crate) struct WorkNotify {
    runner: Notify,
    cell_wake: Arc<CellWake>,
}

impl WorkNotify {
    pub(crate) fn new(cell_wake: Arc<CellWake>) -> Self {
        Self {
            runner: Notify::new(),
            cell_wake,
        }
    }

    pub(crate) fn notify_one(&self) {
        self.runner.notify_one();
        self.cell_wake.request();
    }

    pub(crate) fn notify_waiters(&self) {
        self.runner.notify_waiters();
        self.cell_wake.request();
    }

    pub(crate) fn notified(&self) -> Notified<'_> {
        self.runner.notified()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every work wake reaches a waiting cell: a queue route only wakes the
    /// runner, and the cell's wait still rechecks the steering level.
    #[tokio::test]
    async fn a_work_wake_requests_the_cell_wake() {
        let cell_wake = Arc::new(CellWake::new());
        let work = WorkNotify::new(Arc::clone(&cell_wake));
        let mut waiting = cell_wake.subscribe();
        work.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), waiting.awakened())
            .await
            .expect("the work wake fires the cell wake");
        work.notified().await;
    }
}
