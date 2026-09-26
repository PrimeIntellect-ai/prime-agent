//! Session-event subscribers: the send-time routing index.
//!
//! TS parity (`daemon-supervisor.ts handleWorkerFrame`, l.5971): a session
//! event's delivery set is the clients attached to its session, evaluated
//! in the SAME synchronous pass that writes the socket (`for (const client
//! of this.clients) { if (!client.attachedActiveSessionIds.has(...))
//! continue; ... this.writeSerialized(client, ...) }`, l.6353). The Rust
//! ring evaluated that predicate at RECV time in every connection's event
//! arm — a superset in the attach/detach race window that TS cannot
//! produce (an event published before an attach could still be delivered
//! after it, duplicating a row the attach snapshot already carried).
//!
//! This registry moves the predicate to the publish site: every
//! session-event publisher resolves the session's subscriber set under one
//! lock and enqueues into per-connection bounded queues, so delivery is
//! O(attached) instead of O(connections) — the wakeup floor the
//! concurrent-io lane measured (~5.9us/session/append at N=100) — and the
//! delivery boundary is the frame-processing instant, exactly TS's.
//!
//! Ordering: the per-connection queue is FIFO and every publisher takes
//! the registry lock, so per-(session, connection) wire order equals
//! publish order — the same total order the ring gave session events.
//! Broadcast-class events stay on the ring (untouched semantics); the
//! registry never reorders within a session.
//!
//! Loss visibility (finding 4a): a full queue drops the frame and the
//! transition lands in the daemon log — one line per stall cycle per
//! connection, the ring's `Lagged` cadence. Senders whose receiver is gone
//! prune their entry, so a disconnect racing its own cleanup cannot leak.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::mpsc;

/// One connection's subscription state: the session list (the routing
/// index's per-connection view) and the bounded queue its targeted frames
/// ride. Every dispatch path that mutated the old `attached` vec takes
/// this handle; the methods keep the registry and the session list
/// consistent in one direction (the list may briefly lead the registry on
/// attach and lag it on detach, so disconnect cleanup — which walks the
/// list — always covers the registry).
pub(crate) struct ClientSubscriptions {
    connection_id: String,
    sessions: Mutex<Vec<String>>,
    queue: mpsc::Sender<Arc<Value>>,
}

impl ClientSubscriptions {
    pub(crate) fn new(connection_id: String, queue: mpsc::Sender<Arc<Value>>) -> Arc<Self> {
        Arc::new(Self {
            connection_id,
            sessions: Mutex::new(Vec::new()),
            queue,
        })
    }

    /// The attached-session list (pause bookkeeping, detach-on-disconnect
    /// routing): the registry may lag this list momentarily, never lead it.
    pub(crate) fn session_ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().clone()
    }

    pub(crate) fn contains(&self, active_session_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .any(|id| id == active_session_id)
    }

    /// Attach: the session list first (the routing superset), then the
    /// registry — the registry insertion is the delivery boundary, the
    /// same point TS flips `attachedActiveSessionIds` before writing
    /// `session_attached`.
    pub(crate) fn attach(&self, registry: &SessionSubscribers, active_session_id: &str) {
        {
            let mut sessions = self.sessions.lock().unwrap();
            if !sessions.iter().any(|id| id == active_session_id) {
                sessions.push(active_session_id.to_string());
            }
        }
        registry.register(active_session_id, &self.connection_id, self.queue.clone());
    }

    /// Detach: the registry first (delivery stops at the detach instant),
    /// then the session list.
    pub(crate) fn detach(&self, registry: &SessionSubscribers, active_session_id: &str) {
        registry.unregister(active_session_id, &self.connection_id);
        self.sessions
            .lock()
            .unwrap()
            .retain(|id| id != active_session_id);
    }

    /// The stale-id rebind seam: the connection keeps exactly its prior
    /// attached-ness under the current id. The registry's id move is atomic
    /// (one lock spans the unregister and the register, so no publish sees
    /// both or neither), then the session list follows. Returns whether it
    /// was attached (the caller's binding-notice gate).
    pub(crate) fn rebind(
        &self,
        registry: &SessionSubscribers,
        selector: &str,
        current: &str,
    ) -> bool {
        let was_attached = self.contains(selector);
        if was_attached {
            registry.move_subscription(selector, current, &self.connection_id, self.queue.clone());
            let mut sessions = self.sessions.lock().unwrap();
            sessions.retain(|id| id != selector);
            if !sessions.iter().any(|id| id == current) {
                sessions.push(current.to_string());
            }
        }
        was_attached
    }

    /// Disconnect: every list entry's registry subscription goes (the
    /// list is the superset, so a momentary attach-in-flight cannot leak),
    /// then the caller routes the worker-side detaches as before.
    pub(crate) fn detach_all(&self, registry: &SessionSubscribers) {
        for active_session_id in self.sessions.lock().unwrap().clone() {
            registry.unregister(&active_session_id, &self.connection_id);
        }
    }
}

/// One subscriber's queue, with the one-line-per-stall-cycle loss flag.
struct Subscriber {
    queue: mpsc::Sender<Arc<Value>>,
    logged_full: bool,
}

/// The delivery outcome the publisher must surface: connections whose
/// queue dropped the frame this publish (a stall-cycle transition).
#[derive(Default)]
pub(crate) struct PublishOutcome {
    pub(crate) delivered: usize,
    pub(crate) lagged: Vec<String>,
}

/// The send-time routing index: session id -> connection id -> queue.
pub(crate) struct SessionSubscribers {
    sessions: Mutex<HashMap<String, HashMap<String, Subscriber>>>,
}

impl SessionSubscribers {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn register(
        &self,
        active_session_id: &str,
        connection_id: &str,
        queue: mpsc::Sender<Arc<Value>>,
    ) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions
            .entry(active_session_id.to_string())
            .or_default()
            .insert(
                connection_id.to_string(),
                Subscriber {
                    queue,
                    logged_full: false,
                },
            );
    }

    fn unregister(&self, active_session_id: &str, connection_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(subscribers) = sessions.get_mut(active_session_id) {
            subscribers.remove(connection_id);
            if subscribers.is_empty() {
                sessions.remove(active_session_id);
            }
        }
    }

    /// Move one connection's subscription between session ids atomically
    /// (the rebind seam): a publisher never observes the connection under
    /// both ids or neither.
    fn move_subscription(
        &self,
        from: &str,
        to: &str,
        connection_id: &str,
        queue: mpsc::Sender<Arc<Value>>,
    ) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(subscribers) = sessions.get_mut(from) {
            subscribers.remove(connection_id);
            if subscribers.is_empty() {
                sessions.remove(from);
            }
        }
        sessions.entry(to.to_string()).or_default().insert(
            connection_id.to_string(),
            Subscriber {
                queue,
                logged_full: false,
            },
        );
    }

    /// The send-time delivery pass: enqueue to every attached connection
    /// under the registry lock. A full queue drops the frame and the
    /// stall-cycle transition is returned for the daemon log; a closed
    /// queue prunes its entry (the receiver left; its cleanup either ran
    /// or lost the race, and the prune is the backstop).
    pub(crate) fn publish(&self, active_session_id: &str, payload: Arc<Value>) -> PublishOutcome {
        let mut outcome = PublishOutcome::default();
        let mut sessions = self.sessions.lock().unwrap();
        let Some(subscribers) = sessions.get_mut(active_session_id) else {
            return outcome;
        };
        subscribers.retain(|connection_id, subscriber| {
            match subscriber.queue.try_send(Arc::clone(&payload)) {
                Ok(()) => {
                    outcome.delivered += 1;
                    subscriber.logged_full = false;
                    true
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    if !subscriber.logged_full {
                        subscriber.logged_full = true;
                        outcome.lagged.push(connection_id.clone());
                    }
                    true
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
        if subscribers.is_empty() {
            sessions.remove(active_session_id);
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(capacity: usize) -> (mpsc::Sender<Arc<Value>>, mpsc::Receiver<Arc<Value>>) {
        tokio::sync::mpsc::channel(capacity)
    }

    fn frame(tag: &str) -> Arc<Value> {
        std::sync::Arc::new(serde_json::json!({ "type": tag }))
    }

    async fn drained(rx: &mut mpsc::Receiver<Arc<Value>>) -> Vec<Value> {
        let mut seen = Vec::new();
        while let Ok(payload) = rx.try_recv() {
            seen.push((*payload).clone());
        }
        seen
    }

    #[tokio::test]
    async fn publish_reaches_only_the_attached_connection() {
        let registry = SessionSubscribers::new();
        let (first_tx, mut first_rx) = queue(8);
        let (second_tx, mut second_rx) = queue(8);
        let first = ClientSubscriptions::new("first".into(), first_tx);
        let second = ClientSubscriptions::new("second".into(), second_tx);
        first.attach(&registry, "session-1");
        let outcome = registry.publish("session-1", frame("hello"));
        assert_eq!(outcome.delivered, 1);
        assert!(outcome.lagged.is_empty());
        // An unattached connection's queue stays empty: the frame never
        // even reaches it (the send-time routing set is the attached set).
        assert!(drained(&mut second_rx).await.is_empty());
        assert_eq!(drained(&mut first_rx).await.len(), 1);
        second.attach(&registry, "session-1");
        let outcome = registry.publish("session-1", frame("again"));
        assert_eq!(outcome.delivered, 2);
        assert_eq!(drained(&mut first_rx).await.len(), 1);
        assert_eq!(drained(&mut second_rx).await.len(), 1);
        // A session nobody attached never registers an entry.
        registry.publish("session-2", frame("nobody"));
        assert!(drained(&mut first_rx).await.is_empty());
    }

    #[tokio::test]
    async fn detach_stops_delivery_at_the_detach_instant() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(8);
        let client = ClientSubscriptions::new("client".into(), tx);
        client.attach(&registry, "session-1");
        client.detach(&registry, "session-1");
        let outcome = registry.publish("session-1", frame("late"));
        assert_eq!(outcome.delivered, 0);
        assert!(drained(&mut rx).await.is_empty());
        assert!(!client.contains("session-1"));
    }

    #[tokio::test]
    async fn rebind_moves_the_subscription_between_ids() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(8);
        let client = ClientSubscriptions::new("client".into(), tx);
        client.attach(&registry, "stale");
        assert!(client.rebind(&registry, "stale", "current"));
        let outcome = registry.publish("stale", frame("old-id"));
        assert_eq!(outcome.delivered, 0);
        let outcome = registry.publish("current", frame("new-id"));
        assert_eq!(outcome.delivered, 1);
        assert!(client.contains("current"));
        assert!(!client.contains("stale"));
        // The binding notice rides the new id's subscription.
        assert_eq!(drained(&mut rx).await.len(), 1);
        // A rebind of a connection that was never attached stays one.
        assert!(!client.rebind(&registry, "other", "fresh"));
    }

    #[tokio::test]
    async fn a_full_queue_drops_once_per_stall_cycle() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(2);
        let client = ClientSubscriptions::new("slow".into(), tx);
        client.attach(&registry, "session-1");
        // Fill the queue; every further publish drops, but the stall
        // cycle reports once (the log cadence the ring's Lagged had).
        let mut lagged_lines = 0;
        for index in 0..5 {
            let outcome = registry.publish("session-1", frame(&format!("f{index}")));
            lagged_lines += outcome.lagged.len();
        }
        assert_eq!(lagged_lines, 1);
        // The frames that fit arrive in publish order.
        let frames = drained(&mut rx).await;
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["type"], "f0");
        assert_eq!(frames[1]["type"], "f1");
        // A drained queue resets the cycle: the next stall reports again.
        let outcome = registry.publish("session-1", frame("f5"));
        assert_eq!(outcome.delivered, 1);
        let outcome = registry.publish("session-1", frame("f6"));
        assert!(outcome.lagged.is_empty());
        let outcome = registry.publish("session-1", frame("f7"));
        assert_eq!(outcome.lagged.len(), 1);
    }

    #[tokio::test]
    async fn a_closed_queue_prunes_its_subscription() {
        let registry = SessionSubscribers::new();
        let (tx, rx) = queue(2);
        let client = ClientSubscriptions::new("gone".into(), tx);
        client.attach(&registry, "session-1");
        drop(rx);
        let outcome = registry.publish("session-1", frame("after-close"));
        assert_eq!(outcome.delivered, 0);
        // The prune freed the session entry: the list stays consistent for
        // disconnect cleanup.
        client.detach_all(&registry);
        let outcome = registry.publish("session-1", frame("after-prune"));
        assert_eq!(outcome.delivered, 0);
    }

    #[tokio::test]
    async fn attach_is_idempotent_and_disconnect_clears_every_session() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(8);
        let client = ClientSubscriptions::new("client".into(), tx);
        client.attach(&registry, "a");
        client.attach(&registry, "a");
        client.attach(&registry, "b");
        let outcome = registry.publish("a", frame("one"));
        assert_eq!(
            outcome.delivered,
            1,
            "a duplicate attach must not double-deliver"
        );
        assert_eq!(drained(&mut rx).await.len(), 1);
        client.detach_all(&registry);
        assert_eq!(registry.publish("b", frame("late")).delivered, 0);
        assert!(drained(&mut rx).await.is_empty());
    }
}
