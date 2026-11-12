//! The cell wake: the out-of-band signal that a held turn's wait on a
//! running cell should return early (a user message or inbox arrival
//! interrupted the wait, or the wait budget elapsed). The cell itself is
//! never signalled: it keeps running in the kernel and its completion is
//! routed to the inbox as a notice.

use tokio::sync::watch;

/// A shared wake source. [`CellWake::request`] bumps the generation; every
/// receiver created by [`CellWake::subscribe`] fires on the first bump after
/// it subscribed. Requests that happened before a subscription are invisible
/// to it, so a stale wake can never detach a later cell.
#[derive(Debug)]
pub struct CellWake {
    sender: watch::Sender<u64>,
}

impl Clone for CellWake {
    /// A handle to the same wake source (requests fire every subscriber of
    /// either handle).
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}

impl Default for CellWake {
    fn default() -> Self {
        Self::new()
    }
}

impl CellWake {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sender: watch::channel(0_u64).0,
        }
    }

    /// Request a wake: every live subscription fires once.
    pub fn request(&self) {
        let next = self.sender.borrow().wrapping_add(1);
        let _ = self.sender.send_replace(next);
    }

    /// Subscribe a receiver that fires on the next request.
    #[must_use]
    pub fn subscribe(&self) -> CellWakeReceiver {
        let mut receiver = self.sender.subscribe();
        // Mark the current generation seen: only requests after this point
        // fire this subscription.
        receiver.borrow_and_update();
        CellWakeReceiver { receiver }
    }
}

/// One execution's wake subscription.
#[derive(Debug)]
pub struct CellWakeReceiver {
    receiver: watch::Receiver<u64>,
}

impl CellWakeReceiver {
    /// Resolve on the next wake request. Never resolves once the sender is
    /// dropped.
    pub async fn awakened(&mut self) {
        let _ = self.receiver.changed().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_request_fires_live_subscriptions_once() {
        let wake = CellWake::new();
        let mut receiver = wake.subscribe();
        wake.request();
        tokio::time::timeout(Duration::from_secs(1), receiver.awakened())
            .await
            .expect("a live subscription fires");
        // The bump is consumed once: a second wait needs a second request.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), receiver.awakened())
                .await
                .is_err()
        );
        wake.request();
        tokio::time::timeout(Duration::from_secs(1), receiver.awakened())
            .await
            .expect("the next request fires again");
    }

    #[tokio::test]
    async fn requests_before_a_subscription_are_invisible() {
        let wake = CellWake::new();
        wake.request();
        wake.request();
        let mut receiver = wake.subscribe();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), receiver.awakened())
                .await
                .is_err(),
            "a stale wake never detaches a later cell"
        );
        wake.request();
        tokio::time::timeout(Duration::from_secs(1), receiver.awakened())
            .await
            .expect("a fresh request still fires");
    }
}
