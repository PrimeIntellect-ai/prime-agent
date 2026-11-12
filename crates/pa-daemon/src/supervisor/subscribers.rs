//! Session-event subscribers: the send-time routing index (TS `handleWorkerFrame`:
//! the delivery set is the session's attached clients, evaluated in the socket-write
//! pass). Publishers resolve the set under one lock and enqueue into per-connection
//! bounded queues; a full queue drops with one log line per stall cycle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::mpsc;

/// One connection's subscription state: the session list and the bounded queue its
/// targeted frames ride. The list leads the registry on attach and lags on detach, so
/// disconnect cleanup always covers the registry.
pub(crate) struct ClientSubscriptions {
    connection_id: String,
    sessions: Mutex<Vec<String>>,
    queue: mpsc::Sender<Arc<Value>>,
    /// The connection's client kind (the command envelope's `clientId`
    /// prefix — "a2a", "acp", "tui"), latched at the first command that
    /// names one: the session-event routing reads it (the A2A link
    /// alone receives the run-anchor attribution beside the bare
    /// shared broadcast).
    kind: Mutex<Option<String>>,
}

impl ClientSubscriptions {
    pub(crate) fn new(connection_id: String, queue: mpsc::Sender<Arc<Value>>) -> Arc<Self> {
        Arc::new(Self {
            connection_id,
            sessions: Mutex::new(Vec::new()),
            queue,
            kind: Mutex::new(None),
        })
    }

    /// Latch the connection's client kind (the first envelope that
    /// carries a `clientId` prefix wins; a connection's kind never
    /// changes).
    pub(crate) fn note_client_kind(&self, client_id: &str) {
        if let Some((kind, _)) = client_id.split_once(':') {
            if !kind.is_empty() {
                self.kind
                    .lock()
                    .unwrap()
                    .get_or_insert_with(|| kind.to_string());
            }
        }
    }

    /// Whether this connection is the A2A mode's link (the one client
    /// kind the run-anchor attribution is minted for).
    fn is_a2a(&self) -> bool {
        self.kind.lock().unwrap().as_deref() == Some("a2a")
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
    /// registry — the registry insertion is the delivery boundary.
    pub(crate) fn attach(&self, registry: &SessionSubscribers, active_session_id: &str) {
        {
            let mut sessions = self.sessions.lock().unwrap();
            if !sessions.iter().any(|id| id == active_session_id) {
                sessions.push(active_session_id.to_string());
            }
        }
        registry.register(
            active_session_id,
            &self.connection_id,
            self.queue.clone(),
            self.is_a2a(),
        );
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

    /// The stale-id rebind seam: the connection keeps its prior attached-ness
    /// under the current id. The registry's id move is atomic (one lock spans
    /// the unregister and the register). Returns whether it was attached.
    pub(crate) fn rebind(
        &self,
        registry: &SessionSubscribers,
        selector: &str,
        current: &str,
    ) -> bool {
        let was_attached = self.contains(selector);
        if was_attached {
            registry.move_subscription(
                selector,
                current,
                &self.connection_id,
                self.queue.clone(),
                self.is_a2a(),
            );
            let mut sessions = self.sessions.lock().unwrap();
            sessions.retain(|id| id != selector);
            if !sessions.iter().any(|id| id == current) {
                sessions.push(current.to_string());
            }
        }
        was_attached
    }

    /// Disconnect: every list entry's registry subscription goes (the list is the
    /// superset, so an attach-in-flight cannot leak).
    pub(crate) fn detach_all(&self, registry: &SessionSubscribers) {
        for active_session_id in self.sessions.lock().unwrap().clone() {
            registry.unregister(&active_session_id, &self.connection_id);
        }
    }
}

/// One subscriber's queue, with the one-line-per-stall-cycle loss flag
/// and the connection's kind (the A2A link receives the run-anchor
/// attribution; every other client rides the bare shared broadcast).
struct Subscriber {
    queue: mpsc::Sender<Arc<Value>>,
    logged_full: bool,
    a2a: bool,
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
        a2a: bool,
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
                    a2a,
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
        a2a: bool,
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
                a2a,
            },
        );
    }

    /// The send-time delivery pass: enqueue to every attached
    /// connection under the registry lock. A full queue drops the
    /// frame (the stall-cycle lands in the daemon log); a closed queue
    /// prunes its entry.
    pub(crate) fn publish(&self, active_session_id: &str, payload: &Arc<Value>) -> PublishOutcome {
        self.deliver(active_session_id, |_| payload)
    }

    /// The attributed delivery pass (the `agent_start` run-anchor
    /// frames): every attached connection receives the bare frame —
    /// byte-identical to the TS wire on every shared socket — except
    /// the A2A link's own connection, which receives the tagged copy
    /// carrying the run's delivery identity (the one consumer the
    /// attribution exists for; a Rust-only daemon extension, no TS
    /// client sends the tagged copy).
    pub(crate) fn publish_attributed(
        &self,
        active_session_id: &str,
        bare: &Arc<Value>,
        tagged: &Arc<Value>,
    ) -> PublishOutcome {
        self.deliver(active_session_id, |subscriber| {
            if subscriber.a2a {
                tagged
            } else {
                bare
            }
        })
    }

    /// The one send-time delivery walk under the registry lock; the
    /// selector picks each subscriber's payload (the borrowed payload
    /// lives past the walk — the selector's output lifetime is the
    /// caller's, never the subscriber's).
    fn deliver<'p>(
        &self,
        active_session_id: &str,
        select: impl Fn(&Subscriber) -> &'p Arc<Value>,
    ) -> PublishOutcome {
        let mut outcome = PublishOutcome::default();
        let mut sessions = self.sessions.lock().unwrap();
        let Some(subscribers) = sessions.get_mut(active_session_id) else {
            return outcome;
        };
        subscribers.retain(|connection_id, subscriber| {
            match subscriber.queue.try_send(Arc::clone(select(subscriber))) {
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

    fn drained(rx: &mut mpsc::Receiver<Arc<Value>>) -> Vec<Value> {
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
        let outcome = registry.publish("session-1", &frame("hello"));
        assert_eq!(outcome.delivered, 1);
        assert!(outcome.lagged.is_empty());
        // An unattached connection's queue stays empty: the frame never
        // even reaches it (the send-time routing set is the attached set).
        assert!(drained(&mut second_rx).is_empty());
        assert_eq!(drained(&mut first_rx).len(), 1);
        second.attach(&registry, "session-1");
        let outcome = registry.publish("session-1", &frame("again"));
        assert_eq!(outcome.delivered, 2);
        assert_eq!(drained(&mut first_rx).len(), 1);
        assert_eq!(drained(&mut second_rx).len(), 1);
        // A session nobody attached never registers an entry.
        registry.publish("session-2", &frame("nobody"));
        assert!(drained(&mut first_rx).is_empty());
    }

    #[tokio::test]
    async fn detach_stops_delivery_at_the_detach_instant() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(8);
        let client = ClientSubscriptions::new("client".into(), tx);
        client.attach(&registry, "session-1");
        client.detach(&registry, "session-1");
        let outcome = registry.publish("session-1", &frame("late"));
        assert_eq!(outcome.delivered, 0);
        assert!(drained(&mut rx).is_empty());
        assert!(!client.contains("session-1"));
    }

    #[tokio::test]
    async fn rebind_moves_the_subscription_between_ids() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(8);
        let client = ClientSubscriptions::new("client".into(), tx);
        client.attach(&registry, "stale");
        assert!(client.rebind(&registry, "stale", "current"));
        let outcome = registry.publish("stale", &frame("old-id"));
        assert_eq!(outcome.delivered, 0);
        let outcome = registry.publish("current", &frame("new-id"));
        assert_eq!(outcome.delivered, 1);
        assert!(client.contains("current"));
        assert!(!client.contains("stale"));
        // The binding notice rides the new id's subscription.
        assert_eq!(drained(&mut rx).len(), 1);
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
            let outcome = registry.publish("session-1", &frame(&format!("f{index}")));
            lagged_lines += outcome.lagged.len();
        }
        assert_eq!(lagged_lines, 1);
        // The frames that fit arrive in publish order.
        let frames = drained(&mut rx);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["type"], "f0");
        assert_eq!(frames[1]["type"], "f1");
        // A drained queue resets the cycle: the next stall reports again.
        let outcome = registry.publish("session-1", &frame("f5"));
        assert_eq!(outcome.delivered, 1);
        let outcome = registry.publish("session-1", &frame("f6"));
        assert!(outcome.lagged.is_empty());
        let outcome = registry.publish("session-1", &frame("f7"));
        assert_eq!(outcome.lagged.len(), 1);
    }

    #[tokio::test]
    async fn a_closed_queue_prunes_its_subscription() {
        let registry = SessionSubscribers::new();
        let (tx, rx) = queue(2);
        let client = ClientSubscriptions::new("gone".into(), tx);
        client.attach(&registry, "session-1");
        drop(rx);
        let outcome = registry.publish("session-1", &frame("after-close"));
        assert_eq!(outcome.delivered, 0);
        // The prune freed the session entry: the list stays consistent for
        // disconnect cleanup.
        client.detach_all(&registry);
        let outcome = registry.publish("session-1", &frame("after-prune"));
        assert_eq!(outcome.delivered, 0);
    }

    /// The attributed delivery (the `agent_start` run-anchor frames):
    /// the A2A-kind connection alone receives the tagged payload; every
    /// other attached connection receives the bare one — the shared
    /// broadcast stays byte-identical for the plain clients. Reverting
    /// the kind split (the bare frame to everyone) fails the tagged
    /// assertion; removing the attributed publish fails the bare one.
    #[tokio::test]
    async fn the_attributed_frame_reaches_only_the_a2a_connection() {
        let registry = SessionSubscribers::new();
        let (a2a_tx, mut a2a_rx) = queue(8);
        let (tui_tx, mut tui_rx) = queue(8);
        let a2a = ClientSubscriptions::new("a2a-conn".into(), a2a_tx);
        let tui = ClientSubscriptions::new("tui-conn".into(), tui_tx);
        a2a.note_client_kind("a2a:4242");
        tui.note_client_kind("tui:1111");
        a2a.attach(&registry, "session-1");
        tui.attach(&registry, "session-1");
        let bare = frame("agent_start-bare");
        let tagged = frame("agent_start-tagged");
        let outcome = registry.publish_attributed("session-1", &bare, &tagged);
        assert_eq!(outcome.delivered, 2);
        let a2a_frames = drained(&mut a2a_rx);
        let tui_frames = drained(&mut tui_rx);
        assert_eq!(a2a_frames[0]["type"], "agent_start-tagged");
        assert_eq!(
            tui_frames[0]["type"], "agent_start-bare",
            "the shared broadcast stays bare for every non-a2a client"
        );
        // A connection that never named a client id is not an a2a link.
        let (plain_tx, mut plain_rx) = queue(8);
        let plain = ClientSubscriptions::new("plain-conn".into(), plain_tx);
        plain.attach(&registry, "session-1");
        registry.publish_attributed("session-1", &bare, &tagged);
        assert_eq!(drained(&mut plain_rx)[0]["type"], "agent_start-bare");
        assert_eq!(drained(&mut a2a_rx)[0]["type"], "agent_start-tagged");
    }

    #[tokio::test]
    async fn attach_is_idempotent_and_disconnect_clears_every_session() {
        let registry = SessionSubscribers::new();
        let (tx, mut rx) = queue(8);
        let client = ClientSubscriptions::new("client".into(), tx);
        client.attach(&registry, "a");
        client.attach(&registry, "a");
        client.attach(&registry, "b");
        let outcome = registry.publish("a", &frame("one"));
        assert_eq!(
            outcome.delivered, 1,
            "a duplicate attach must not double-deliver"
        );
        assert_eq!(drained(&mut rx).len(), 1);
        client.detach_all(&registry);
        assert_eq!(registry.publish("b", &frame("late")).delivered, 0);
        assert!(drained(&mut rx).is_empty());
    }
}
