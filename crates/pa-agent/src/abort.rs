//! Abort plumbing: a cloneable `AbortSignal`, plus the abort-race helpers
//! the agent loop uses on every await point.

use std::future::Future;
use std::sync::Arc;
use tokio::sync::watch;

/// Error type used for every abort path; its message matches the TS
/// reference (`ABORT_ERROR_MESSAGE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Request was aborted")]
pub struct AbortedError;

pub const ABORT_ERROR_MESSAGE: &str = "Request was aborted";

#[must_use]
pub fn aborted_error() -> anyhow::Error {
    anyhow::Error::new(AbortedError)
}

/// The TS reference also treats any `Error` named `AbortError` or with the
/// exact message "Request was aborted" as an abort. Provider-level aborts
/// never throw in this port (they arrive as terminal stream events), so the
/// typed marker is the single abort signal on the error path.
#[must_use]
pub fn is_abort_error(err: &anyhow::Error) -> bool {
    err.downcast_ref::<AbortedError>().is_some()
}

#[derive(Debug)]
struct SignalInner {
    tx: watch::Sender<bool>,
}

/// Cloneable handle that observes an [`AbortController`].
///
/// The TS `AbortSignal` registers abort listeners; here observers await
/// [`AbortSignal::aborted`].
#[derive(Clone)]
pub struct AbortSignal {
    inner: Arc<SignalInner>,
    rx: watch::Receiver<bool>,
}

impl Default for AbortSignal {
    fn default() -> Self {
        AbortController::new().signal()
    }
}

impl std::fmt::Debug for AbortSignal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AbortSignal")
            .field("aborted", &self.is_aborted())
            .finish()
    }
}

impl AbortSignal {
    #[must_use]
    pub fn never() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn is_aborted(&self) -> bool {
        *self.rx.borrow()
    }

    /// Resolves once the signal is aborted. Safe to await concurrently from any
    /// number of tasks.
    pub async fn aborted(&self) {
        let mut rx = self.rx.clone();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                // The controller was dropped without aborting; TS semantics keep the
                // signal pending in that case.
                std::future::pending::<()>().await;
            }
        }
    }

    fn watch_pair(tx: watch::Sender<bool>, rx: watch::Receiver<bool>) -> Self {
        Self {
            inner: Arc::new(SignalInner { tx }),
            rx,
        }
    }

    pub(crate) fn sender(&self) -> watch::Sender<bool> {
        self.inner.tx.clone()
    }
}

/// Creates and owns an [`AbortSignal`].
#[derive(Debug, Clone)]
pub struct AbortController {
    signal: AbortSignal,
}

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortController {
    #[must_use]
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            signal: AbortSignal::watch_pair(tx, rx),
        }
    }

    #[must_use]
    pub fn signal(&self) -> AbortSignal {
        self.signal.clone()
    }

    /// Abort the signal. Idempotent, like the TS controller.
    pub fn abort(&self) {
        let _ = self.signal.sender().send(true);
    }

    #[must_use]
    pub fn is_aborted(&self) -> bool {
        self.signal.is_aborted()
    }
}

/// Reject with an abort error as soon as `signal` aborts; otherwise resolve
/// with the future's output.
///
/// # Errors
///
/// Returns `AbortedError` if `signal` is already aborted, or aborts before `operation` completes.
pub async fn race_with_abort<T, F>(operation: F, signal: &AbortSignal) -> anyhow::Result<T>
where
    F: Future<Output = T>,
{
    if signal.is_aborted() {
        drop(operation);
        return Err(aborted_error());
    }
    tokio::select! {
        // A cancellation the caller requested wins over a result that became
        // ready in the same poll: the abort branch is polled first, and the
        // result branch re-checks the signal through `consume_unless_aborted`.
        biased;
        () = signal.aborted() => Err(aborted_error()),
        value = operation => consume_unless_aborted(value, signal),
    }
}

/// Consume an operation's result unless a cancellation is already requested.
///
/// The check reads the signal at the moment the result is consumed, not when
/// the race started: a result that became ready in the same poll as the abort
/// is not work the caller still wants, so it reports cancelled.
fn consume_unless_aborted<T>(result: T, signal: &AbortSignal) -> anyhow::Result<T> {
    if signal.is_aborted() {
        Err(aborted_error())
    } else {
        Ok(result)
    }
}

/// Race an operation against an abort signal, and keep a result that is ready.
///
/// The operation is polled first, and its result is not re-checked. Use this
/// for work that is durable once it produces a result: a cancellation that
/// arrives in the poll that makes the result does not replace the result.
/// The operation must check the signal before it commits.
///
/// # Errors
///
/// Returns `AbortedError` if `signal` is already aborted, or if it aborts before `operation` completes.
pub async fn race_keep_result<T, F>(operation: F, signal: &AbortSignal) -> anyhow::Result<T>
where
    F: Future<Output = T>,
{
    if signal.is_aborted() {
        drop(operation);
        return Err(aborted_error());
    }
    tokio::select! {
        biased;
        value = operation => Ok(value),
        () = signal.aborted() => Err(aborted_error()),
    }
}

/// # Errors
///
/// Returns the abort error (`AbortedError`) if `signal` is already aborted.
pub fn throw_if_aborted(signal: &AbortSignal) -> anyhow::Result<()> {
    if signal.is_aborted() {
        Err(aborted_error())
    } else {
        Ok(())
    }
}

/// `throwIfAborted` with an optional signal (the TS loop calls it with `signal | undefined`).
///
/// # Errors
///
/// Returns `AbortedError` if the provided signal is already aborted.
pub fn throw_if_aborted_signal(signal: Option<&AbortSignal>) -> anyhow::Result<()> {
    match signal {
        Some(signal) => throw_if_aborted(signal),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn abort_signal_observers_wake_up() {
        let controller = AbortController::new();
        let signal = controller.signal();
        assert!(!signal.is_aborted());
        let observer = tokio::spawn({
            let signal = signal.clone();
            async move {
                signal.aborted().await;
                true
            }
        });
        controller.abort();
        assert!(signal.is_aborted());
        assert!(observer.await.unwrap());
    }

    #[tokio::test]
    async fn race_with_abort_wins_on_abort() {
        let controller = AbortController::new();
        let signal = controller.signal();
        let aborter = {
            let controller = controller.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                controller.abort();
            })
        };
        let err = race_with_abort(std::future::pending::<()>(), &signal)
            .await
            .unwrap_err();
        aborter.await.unwrap();
        assert!(is_abort_error(&err));
    }

    #[tokio::test]
    async fn race_with_abort_resolves_operation() {
        let signal = AbortSignal::never();
        let value = race_with_abort(async { 7 }, &signal).await.unwrap();
        assert_eq!(value, 7);
    }

    #[tokio::test]
    async fn race_keep_result_keeps_a_result_that_is_ready_with_the_abort() {
        // The result and the abort both become ready before the second poll.
        // The operation branch is polled first and is not re-checked, so the
        // result stands even though the signal is aborted.
        let controller = AbortController::new();
        let signal = controller.signal();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mut race = std::pin::pin!(race_keep_result(receiver, &signal));
        let first = std::future::poll_fn(|cx| std::task::Poll::Ready(race.as_mut().poll(cx))).await;
        assert!(first.is_pending());
        sender.send(7).unwrap();
        controller.abort();
        assert_eq!(race.await.unwrap().unwrap(), 7);
    }

    #[tokio::test]
    async fn race_keep_result_still_cancels_before_a_result() {
        let controller = AbortController::new();
        let signal = controller.signal();
        let aborter = {
            let controller = controller.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                controller.abort();
            })
        };
        let error = race_keep_result(std::future::pending::<()>(), &signal)
            .await
            .unwrap_err();
        aborter.await.unwrap();
        assert!(is_abort_error(&error));
    }

    #[tokio::test]
    async fn race_keep_result_short_circuits_a_pre_aborted_signal() {
        let controller = AbortController::new();
        controller.abort();
        let error = race_keep_result(async { 7 }, &controller.signal())
            .await
            .unwrap_err();
        assert!(is_abort_error(&error));
    }

    #[test]
    fn a_completed_result_reports_cancelled_once_the_abort_is_requested() {
        // The result was ready before the caller consumed it, and the abort
        // was requested before the caller consumed it: the cancelled outcome
        // wins. One call, no poll order involved, so the assertion is exact.
        let controller = AbortController::new();
        let signal = controller.signal();
        controller.abort();
        let error = consume_unless_aborted(7, &signal).unwrap_err();
        assert!(is_abort_error(&error));
        // An un-aborted signal still delivers the result.
        let live = AbortController::new();
        assert_eq!(consume_unless_aborted(7, &live.signal()).unwrap(), 7);
    }

    #[tokio::test]
    async fn a_requested_abort_wins_over_a_result_ready_in_the_same_poll() {
        // The operation requests the abort in the poll that makes its result,
        // so the abort branch has not seen it. Only the re-check in the result
        // branch reports cancelled, and poll order cannot change that, so one
        // run is exact.
        let controller = AbortController::new();
        let signal = controller.signal();
        let result = race_with_abort(
            async {
                controller.abort();
                7
            },
            &signal,
        )
        .await;
        assert!(is_abort_error(&result.unwrap_err()));
    }

    #[tokio::test]
    async fn pre_aborted_signal_short_circuits() {
        let controller = AbortController::new();
        controller.abort();
        assert!(throw_if_aborted(&controller.signal()).is_err());
    }
}
