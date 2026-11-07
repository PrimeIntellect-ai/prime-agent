//! The kernel process lifecycle: one holder whose state only `transition` writes.

use super::{oneshot, Arc, MemoSlot};

/// The coarse view of [`Lifecycle`] most readers need.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum KernelState {
    Idle,
    Starting,
    Running,
    Shutdown,
}

/// The kernel process lifecycle. Data that only exists in one phase lives in its variant.
pub(super) enum Lifecycle {
    /// No child; the next start spawns one.
    Idle,
    Starting(Starting),
    Running,
    /// A graceful shutdown owns the teardown of this start generation, so the exit
    /// handler must not run it.
    ShuttingDown {
        generation: u64,
    },
    /// A protocol repair is killing the child to settle at `Idle` (not defunct).
    Discarding,
    /// Torn down. Only `restart()` and a failed start that resets for a retry (startup
    /// or protocol repair) move it back to `Idle`.
    Defunct,
}

pub(super) struct Starting {
    /// Concurrent starts join this run. `None` once the run failed after the handshake
    /// (protocol error or mismatch): the caller tears the half-started kernel down.
    pub(super) start: Option<Arc<MemoSlot>>,
    pub(super) ready_tx: Option<oneshot::Sender<anyhow::Result<i64>>>,
    /// A protocol error that arrived before the ready frame.
    pub(super) protocol_error: Option<String>,
}

impl Lifecycle {
    /// A start that concurrent starts join through `start`.
    pub(super) fn starting(start: Arc<MemoSlot>) -> Self {
        Self::Starting(Starting {
            start: Some(start),
            ready_tx: None,
            protocol_error: None,
        })
    }
}

/// The lifecycle and its start generation. Teardowns and newer starts bump the
/// generation, so work that captured an older one knows it is stale.
pub(super) struct KernelLifecycle {
    current: Lifecycle,
    generation: u64,
}

impl KernelLifecycle {
    pub(super) fn new() -> Self {
        Self {
            current: Lifecycle::Idle,
            generation: 0,
        }
    }

    /// The only lifecycle writer. Entering `Starting` allocates the next generation.
    pub(super) fn transition(&mut self, to: Lifecycle) {
        if matches!(to, Lifecycle::Starting(_)) {
            self.generation += 1;
        }
        self.current = to;
    }

    /// A teardown invalidates in-flight starts without changing the lifecycle.
    pub(super) fn invalidate_starts(&mut self) {
        self.generation += 1;
    }

    pub(super) fn current(&self) -> &Lifecycle {
        &self.current
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn phase(&self) -> KernelState {
        match self.current {
            Lifecycle::Idle => KernelState::Idle,
            Lifecycle::Starting(_) => KernelState::Starting,
            Lifecycle::Running => KernelState::Running,
            Lifecycle::ShuttingDown { .. } | Lifecycle::Discarding | Lifecycle::Defunct => {
                KernelState::Shutdown
            }
        }
    }

    /// The data of the start in progress; the lifecycle itself stays unchanged.
    pub(super) fn starting_mut(&mut self) -> Option<&mut Starting> {
        match &mut self.current {
            Lifecycle::Starting(starting) => Some(starting),
            _ => None,
        }
    }

    /// A graceful shutdown owns the current generation's teardown.
    pub(super) fn graceful_shutdown_in_flight(&self) -> bool {
        matches!(self.current, Lifecycle::ShuttingDown { generation } if generation == self.generation)
    }
}
