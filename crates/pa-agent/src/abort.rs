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
    async fn pre_aborted_signal_short_circuits() {
        let controller = AbortController::new();
        controller.abort();
        assert!(throw_if_aborted(&controller.signal()).is_err());
    }
}
