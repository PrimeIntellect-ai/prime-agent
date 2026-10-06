//! Pacing for the supervisor's background recovery work: the boot
//! recovery runs on background tasks so serving never waits, but a
//! huge sessions dir must not fan out one relaunch per descriptor at
//! once — this module bounds that fan-out.

/// The maximum number of descriptors the boot adoption pass works on at
/// once. An adoption is mostly a socket connect, at most one relaunch
/// spawn; a small cap keeps the pass steady without serializing it.
pub(crate) const ADOPTION_CONCURRENCY: usize = 4;

/// Run background jobs with bounded concurrency: at most `limit` tasks
/// alive at once, the next spawned only when one finishes. Returns when
/// every job has finished (a panicked job settles with its `JoinError`).
pub(crate) async fn run_bounded<F, Fut>(jobs: Vec<F>, limit: usize)
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
            in_flight.spawn(async move {
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
        struct CancellationObserved(std::sync::Arc<AtomicUsize>);
        impl Drop for CancellationObserved {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let entered = std::sync::Arc::new(AtomicUsize::new(0));
        let cancelled = std::sync::Arc::new(AtomicUsize::new(0));
        let pass = tokio::spawn(run_bounded(
            (0..4)
                .map(|_| {
                    let entered = std::sync::Arc::clone(&entered);
                    let cancelled = std::sync::Arc::clone(&cancelled);
                    move || async move {
                        let _observed = CancellationObserved(std::sync::Arc::clone(&cancelled));
                        entered.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    }
                })
                .collect(),
            4,
        ));
        // Wait until all four jobs are parked inside the sleep.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while entered.load(Ordering::SeqCst) < 4 {
            assert!(std::time::Instant::now() < deadline, "jobs never started");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        pass.abort();
        pass.await.unwrap_err();
        // The in-flight fan-out must be cancelled, not detached: every
        // job's cancellation guard runs. (A detached fan-out keeps the
        // guards alive inside the parked sleeps - this is the assertion
        // that fails without the abort-on-drop fan-out.)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while cancelled.load(Ordering::SeqCst) < 4 {
            assert!(
                std::time::Instant::now() < deadline,
                "the in-flight fan-out was not cancelled with the pass"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
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
        run_bounded(jobs, ADOPTION_CONCURRENCY).await;
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
        run_bounded(jobs, ADOPTION_CONCURRENCY).await;
        assert_eq!(ran.load(Ordering::SeqCst), 3);
    }
}
