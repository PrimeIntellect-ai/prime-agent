//! Pacing for the supervisor's background recovery work.
//!
//! The boot recovery (descriptor adoption, then the roster restore pass)
//! runs on background tasks so serving never waits for it. But
//! "background" must not mean "unbounded": a sessions dir with hundreds
//! of persisted descriptors must not fan out one worker relaunch (a full
//! process spawn plus create replay) per descriptor at once — the spawn
//! storm starves the control plane (new client hellos, `list`, routed
//! commands) for the whole pass. This module bounds that fan-out with a
//! small fixed cap while keeping every job off the serving path.

/// The maximum number of descriptors the boot adoption pass works on at
/// once. An adoption is mostly a socket connect, at most one relaunch
/// spawn; a small cap keeps the pass steady without serializing it.
pub(crate) const ADOPTION_CONCURRENCY: usize = 4;

/// Run background jobs with bounded concurrency: one task per job, at
/// most `limit` running at once. The pass stays fully concurrent with
/// the accept loop and control-plane commands; only the jobs' own
/// fan-out is bounded. Returns when every job has finished (a panicked
/// job settles with its JoinError, like the previous unbounded fan-out).
pub(crate) async fn run_bounded<F, Fut>(jobs: Vec<F>, limit: usize)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(limit.max(1)));
    let mut tasks = Vec::with_capacity(jobs.len());
    for job in jobs {
        let permits = std::sync::Arc::clone(&permits);
        tasks.push(tokio::spawn(async move {
            let permit = permits
                .acquire_owned()
                .await
                .expect("the recovery semaphore is never closed");
            job().await;
            drop(permit);
        }));
    }
    for task in tasks {
        let _ = task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
                    if i == 1 {
                        panic!("one adoption job is allowed to die loudly");
                    }
                    ran.fetch_add(1, Ordering::SeqCst);
                }
            })
            .collect();
        run_bounded(jobs, ADOPTION_CONCURRENCY).await;
        assert_eq!(ran.load(Ordering::SeqCst), 3);
    }
}
