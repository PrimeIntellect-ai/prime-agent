//! Cooperative abort signal for kernel operations.
//!
//! Port of the TypeScript `AbortSignal` usage: aborting a cell interrupts the
//! kernel out-of-band, aborting a start cancels the wait, and an already
//! aborted signal short-circuits the operation.

use tokio_util::sync::CancellationToken;

/// Clonable, awaitable abort signal.
#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    token: CancellationToken,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wrap a raw cancellation token.
    pub fn from_token(token: tokio_util::sync::CancellationToken) -> Self {
        Self { token }
    }

    /// Signal wrapping an already aborted state.
    pub fn aborted() -> Self {
        let signal = Self::new();
        signal.token.cancel();
        signal
    }

    /// Trigger the signal.
    pub fn abort(&self) {
        self.token.cancel();
    }

    /// True once aborted.
    pub fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Resolve when the signal fires (immediately when already aborted).
    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }

    /// Underlying token for composition helpers.
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// True when no signal was provided, or the provided one has not fired.
    pub fn is_active(signal: Option<&AbortSignal>) -> bool {
        match signal {
            None => true,
            Some(s) => !s.is_aborted(),
        }
    }

    /// Combine several signals: the merged signal fires when any source fires.
    pub fn any(sources: Vec<Option<AbortSignal>>) -> Option<AbortSignal> {
        let live: Vec<CancellationToken> = sources
            .into_iter()
            .flatten()
            .map(|s| s.token.clone())
            .collect();
        if live.is_empty() {
            return None;
        }
        let merged = AbortSignal::new();
        for token in live {
            let merged_clone = merged.clone();
            tokio::spawn(async move {
                token.cancelled().await;
                merged_clone.abort();
            });
        }
        Some(merged)
    }
}

/// Merge an optional caller signal with an optional internal timeout signal.
pub(crate) fn merge_signals(
    caller: Option<&AbortSignal>,
    timeout: Option<AbortSignal>,
) -> Option<AbortSignal> {
    match (caller, timeout) {
        (None, None) => None,
        (Some(c), None) => Some(c.clone()),
        (None, Some(t)) => Some(t),
        (Some(c), Some(t)) => {
            if c.is_aborted() {
                return Some(c.clone());
            }
            if t.is_aborted() {
                return Some(t.clone());
            }
            AbortSignal::any(vec![Some(c.clone()), Some(t)])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn aborted_signal_short_circuits() {
        let signal = AbortSignal::aborted();
        assert!(signal.is_aborted());
        signal.cancelled().await;
    }

    #[tokio::test]
    async fn any_merges_sources() {
        let a = AbortSignal::new();
        let merged = AbortSignal::any(vec![Some(a.clone()), Some(AbortSignal::new())]).unwrap();
        assert!(!merged.is_aborted());
        a.abort();
        // merged fires via the spawned listener
        tokio::time::timeout(std::time::Duration::from_secs(1), merged.cancelled())
            .await
            .expect("merged signal should fire");
    }
}
