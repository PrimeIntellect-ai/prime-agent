//! Host-owned cancellation for manual compaction, including external preflight.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use pa_agent::abort::{AbortController, AbortSignal};

#[derive(Default)]
pub(crate) struct CompactionCancellation {
    active: Mutex<Vec<Weak<AbortController>>>,
    closed: AtomicBool,
}

impl CompactionCancellation {
    pub(crate) fn register(&self) -> CompactionOperation {
        let controller = Arc::new(AbortController::new());
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.retain(|operation| operation.strong_count() != 0);
        active.push(Arc::downgrade(&controller));
        if self.closed.load(Ordering::Acquire) {
            controller.abort();
        }
        CompactionOperation(controller)
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.abort();
    }

    pub(crate) fn abort(&self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.retain(|operation| {
            if let Some(controller) = operation.upgrade() {
                controller.abort();
                true
            } else {
                false
            }
        });
    }
}

pub(crate) struct CompactionOperation(Arc<AbortController>);

impl CompactionOperation {
    pub(crate) fn signal(&self) -> AbortSignal {
        self.0.signal()
    }
}

impl Drop for CompactionOperation {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_targets_all_live_operations_and_future_operations_start_fresh() {
        let host = CompactionCancellation::default();
        let first = host.register();
        let second = host.register();
        host.abort();
        assert_eq!(
            [first.signal().is_aborted(), second.signal().is_aborted()],
            [true, true]
        );
        let later = host.register();
        assert!(!later.signal().is_aborted());
        let signal = later.signal();
        drop(later);
        assert!(
            signal.is_aborted(),
            "dropping a handler cancels its operation"
        );
        host.close();
        assert!(
            host.register().signal().is_aborted(),
            "shutdown also cancels queued handlers"
        );
    }
}
