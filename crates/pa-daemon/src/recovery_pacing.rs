//! Pacing for the supervisor's background recovery work: the boot
//! recovery runs on background tasks so serving never waits, but a
//! huge sessions dir must not fan out one relaunch per descriptor at
//! once — this module bounds that fan-out.

/// The maximum number of descriptors the boot adoption pass works on at
/// once. An adoption is mostly a socket connect, at most one relaunch
/// spawn; a small cap keeps the pass steady without serializing it.
pub(crate) const ADOPTION_CONCURRENCY: usize = 4;

/// The settle witness for a pass's nested fan-out. Every spawned job's
/// future carries a drop-guard counting it, so a caller that ABORTS the
/// pass can still await the fan-out's actual settle: the `JoinSet`'s
/// drop abort-flags the children without waiting, and a job mid-step at the
/// abort (a socket connect, a relaunch spawn) finishes that step after
/// the pass's own handle is joined. `wait_drained` resolves only when
/// every job future has been DROPPED - finished, panicked, or cancelled -
/// so no adoption work outlives the fence that awaits it.
#[derive(Clone)]
pub(crate) struct FanoutDrain {
    state: std::sync::Arc<FanoutState>,
}

struct FanoutState {
    pending: std::sync::atomic::AtomicUsize,
    drained: tokio::sync::Notify,
}

impl Default for FanoutDrain {
    fn default() -> Self {
        Self::new()
    }
}

impl FanoutDrain {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            state: std::sync::Arc::new(FanoutState {
                pending: std::sync::atomic::AtomicUsize::new(0),
                drained: tokio::sync::Notify::new(),
            }),
        }
    }

    fn guard(&self) -> FanoutGuard {
        self.state
            .pending
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        FanoutGuard {
            state: std::sync::Arc::clone(&self.state),
        }
    }

    /// Resolve when every spawned job future has settled (its drop-guard
    /// ran). Instant when nothing is in flight. The fence that awaits it
    /// is the unix supervisor's lease-release ordering; the non-unix
    /// daemon has no lease choreography to fence.
    #[cfg(unix)]
    pub(crate) async fn wait_drained(&self) {
        loop {
            if self
                .state
                .pending
                .load(std::sync::atomic::Ordering::Acquire)
                == 0
            {
                return;
            }
            // The notified future is created BEFORE the re-check so a
            // drop landing between the check and the await still wakes it.
            let notified = self.state.drained.notified();
            if self
                .state
                .pending
                .load(std::sync::atomic::Ordering::Acquire)
                == 0
            {
                return;
            }
            notified.await;
        }
    }
}

struct FanoutGuard {
    state: std::sync::Arc<FanoutState>,
}

impl Drop for FanoutGuard {
    fn drop(&mut self) {
        self.state
            .pending
            .fetch_sub(1, std::sync::atomic::Ordering::Release);
        self.state.drained.notify_waiters();
    }
}

/// Run background jobs with bounded concurrency: at most `limit` tasks
/// alive at once, the next spawned only when one finishes. Returns when
/// every job has finished (a panicked job settles with its `JoinError`).
/// Each job counts itself on `drain` for its whole lifetime, so an
/// aborted pass's caller can await the fan-out's settle after the
/// `JoinSet`'s drop has flagged the children.
pub(crate) async fn run_bounded<F, Fut>(jobs: Vec<F>, limit: usize, drain: FanoutDrain)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let limit = limit.max(1);
    let mut jobs = jobs.into_iter().peekable();
    if jobs.peek().is_none() {
        return;
    }
    // JoinSet aborts its children when dropped - including the drop that
    // follows an abort of THIS task: a cancelled adoption pass must not
    // detach its in-flight fan-out to finish against a successor.
    let mut in_flight = tokio::task::JoinSet::new();
    loop {
        while in_flight.len() < limit && jobs.peek().is_some() {
            let job = jobs.next().expect("peeked");
            let guard = drain.guard();
            in_flight.spawn(async move {
                let _settled = guard;
                job().await;
            });
        }
        if in_flight.join_next().await.is_none() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn aborting_the_pass_cancels_the_in_flight_fanout() {
        /// Observes cancellation the only way an aborted task can be seen:
        /// the guard's Drop runs when the job's own task is cancelled -
        /// a detached job stays parked in its sleep and never drops it.
        /// The Drop also SIGNALS the test over the channel (the readiness
        /// witness itself - no polling).
        struct CancellationObserved(std::sync::Arc<tokio::sync::mpsc::Sender<()>>);
        impl Drop for CancellationObserved {
            fn drop(&mut self) {
                let _ = self.0.try_send(());
            }
        }
        // Readiness by CHANNEL, not by polling: each job signals its
        // entry, and its cancellation guard signals the drop; the test
        // awaits the exact counts (the timeout bounds only failure).
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel::<()>(4);
        let (cancelled_tx, mut cancelled_rx) = tokio::sync::mpsc::channel::<()>(4);
        let pass = tokio::spawn(run_bounded(
            (0..4)
                .map(|_| {
                    let entered_tx = entered_tx.clone();
                    let cancelled_tx = cancelled_tx.clone();
                    move || {
                        let entered_tx = entered_tx.clone();
                        let cancelled_tx = cancelled_tx.clone();
                        async move {
                            let _observed =
                                CancellationObserved(std::sync::Arc::new(cancelled_tx.clone()));
                            entered_tx
                                .send(())
                                .await
                                .expect("the entry channel stays open");
                            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        }
                    }
                })
                .collect(),
            4,
            FanoutDrain::new(),
        ));
        for _ in 0..4 {
            tokio::time::timeout(std::time::Duration::from_secs(5), entered_rx.recv())
                .await
                .expect("a job never entered its sleep")
                .expect("the entry channel closed early");
        }
        pass.abort();
        pass.await.unwrap_err();
        // The in-flight fan-out must be cancelled, not detached: every
        // job's cancellation guard runs. (A detached fan-out keeps the
        // guards alive inside the parked sleeps - this is the assertion
        // that fails without the abort-on-drop fan-out.)
        for _ in 0..4 {
            tokio::time::timeout(std::time::Duration::from_secs(5), cancelled_rx.recv())
                .await
                .expect("the in-flight fan-out was not cancelled with the pass")
                .expect("the cancellation channel closed early");
        }
    }

    #[tokio::test]
    async fn bounded_fanout_caps_concurrency_and_runs_every_job() {
        let in_flight = std::sync::Arc::new(AtomicUsize::new(0));
        let max_seen = std::sync::Arc::new(AtomicUsize::new(0));
        let ran = std::sync::Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..16)
            .map(|_| {
                let in_flight = std::sync::Arc::clone(&in_flight);
                let max_seen = std::sync::Arc::clone(&max_seen);
                let ran = std::sync::Arc::clone(&ran);
                move || async move {
                    let entered = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(entered, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    ran.fetch_add(1, Ordering::SeqCst);
                }
            })
            .collect();
        run_bounded(jobs, ADOPTION_CONCURRENCY, FanoutDrain::new()).await;
        assert_eq!(ran.load(Ordering::SeqCst), 16);
        assert!(max_seen.load(Ordering::SeqCst) <= ADOPTION_CONCURRENCY);
        // The cap is a real bound, not a serialization: more than one job
        // ran at once (the scheduler interleaves the parked sleeps).
        assert!(max_seen.load(Ordering::SeqCst) > 1);
    }

    #[tokio::test]
    async fn bounded_fanout_survives_a_panic_in_one_job() {
        let ran = std::sync::Arc::new(AtomicUsize::new(0));
        let jobs: Vec<_> = (0..4)
            .map(|i| {
                let ran = std::sync::Arc::clone(&ran);
                move || async move {
                    assert_ne!(i, 1, "one adoption job is allowed to die loudly");
                    ran.fetch_add(1, Ordering::SeqCst);
                }
            })
            .collect();
        run_bounded(jobs, ADOPTION_CONCURRENCY, FanoutDrain::new()).await;
        assert_eq!(ran.load(Ordering::SeqCst), 3);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 6)]
    async fn an_aborted_pass_drains_its_fan_out_before_the_fence_releases() {
        // The fence's order is reproduced: abort the pass, AWAIT its
        // handle, then await the fan-out's drain. Two jobs enter
        // (channel-signaled, no polling), then hold an UNPREEMPTIBLE
        // blocking step: the aborted pass's `JoinSet` drop flags them,
        // but their futures cannot drop while the step is held - so the
        // drain must NOT complete, the waiter must stay pending, and the
        // drop count must still be zero. Releasing the step lets the
        // flagged futures settle; the drain then resolves and the drops
        // are recorded immediately - the test fails if `wait_drained` is
        // removed or returns early (a no-op drain completes the first
        // await against the pending jobs).
        const JOBS: usize = 2;
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel::<()>(JOBS);
        // One release channel per job (a std Receiver is not cloneable):
        // each step is held while its Sender lives and released by
        // dropping the senders.
        let mut release_senders = Vec::new();
        let mut release_receivers = Vec::new();
        for _ in 0..JOBS {
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            release_senders.push(release_tx);
            release_receivers.push(release_rx);
        }
        let (dropped_tx, dropped_rx) = std::sync::mpsc::channel::<()>();
        let drain = FanoutDrain::new();
        let pass = tokio::spawn(run_bounded(
            (0..JOBS)
                .map(|_| {
                    let entered_tx = entered_tx.clone();
                    let Some(release_rx) = release_receivers.pop() else {
                        unreachable!("one release channel per job");
                    };
                    let dropped_tx = dropped_tx.clone();
                    move || async move {
                        struct Settled(std::sync::mpsc::Sender<()>);
                        impl Drop for Settled {
                            fn drop(&mut self) {
                                let _ = self.0.send(());
                            }
                        }
                        let _dropped = Settled(dropped_tx);
                        // Observable entry, then the blocking in-flight
                        // step no abort can preempt.
                        let _ = entered_tx.send(()).await;
                        let _ = release_rx.recv();
                    }
                })
                .collect(),
            JOBS,
            drain.clone(),
        ));
        // Readiness by channel, not by polling.
        for _ in 0..JOBS {
            tokio::time::timeout(std::time::Duration::from_secs(5), entered_rx.recv())
                .await
                .expect("a job never entered its step")
                .expect("the entry channel closed early");
        }
        pass.abort();
        let _ = pass.await;
        // The fan-out is abort-FLAGGED but its futures are held inside
        // the blocking steps: the drain must not complete here. The
        // timeout is only a failure bound - the jobs cannot settle
        // while the step is held, so a correct drain cannot return.
        tokio::time::timeout(std::time::Duration::from_millis(200), drain.wait_drained())
            .await
            .expect_err("the drain completed while the fan-out was still in flight");
        assert!(
            dropped_rx.try_recv().is_err(),
            "no job future may settle while its step is held"
        );
        // Releasing the steps lets the flagged futures settle; the drain
        // resolves and every settle is recorded immediately.
        drop(release_senders);
        tokio::time::timeout(std::time::Duration::from_secs(5), drain.wait_drained())
            .await
            .expect("the fan-out never drained after the steps released");
        let mut settled = 0;
        while dropped_rx.try_recv().is_ok() {
            settled += 1;
        }
        assert_eq!(
            settled, JOBS,
            "the drain must await every job future's actual settle"
        );
    }
}
